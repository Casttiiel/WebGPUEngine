import { ResourceManager } from '../../../core/engine/ResourceManager';

export class ShaderPreprocessor {
  private static processedShaderCache: Map<string, string> = new Map();
  private static includeFileCache: Map<string, string> = new Map();

  private static async readShaderFile(path: string): Promise<string> {
    // Check include file cache first
    const cached = this.includeFileCache.get(path);
    if (cached) {
      return cached;
    }

    // Fetch and cache the raw include file
    const content = await ResourceManager.fetch(`assets/shaders/${path}`).then((res) => res.text());
    this.includeFileCache.set(path, content);

    return content;
  }

  private static async processIncludes(
    content: string,
    visited: Set<string> = new Set(),
    included: Set<string> = new Set(),
    currentFile: string = '',
  ): Promise<string> {
    const includeRegex = /#include\s*["']([^"']+)["']/g;
    const matches: Array<{ fullMatch: string; includePath: string; index: number }> = [];
    let match: RegExpExecArray | null;

    // First, collect all include matches
    while ((match = includeRegex.exec(content)) !== null) {
      const [fullMatch, includePath] = match;
      if (!includePath) continue;
      matches.push({ fullMatch, includePath, index: match.index });
    }

    // Process includes in reverse order to maintain correct string positions
    let processedContent = content;
    for (let i = matches.length - 1; i >= 0; i--) {
      const { fullMatch, includePath, index } = matches[i];
      const fullPath = includePath.endsWith('.wgsl') ? includePath : `${includePath}.wgsl`;

      // Skip if already included (prevents duplicates from different branches)
      if (included.has(fullPath)) {
        // Just remove the #include directive
        processedContent =
          processedContent.substring(0, index) +
          processedContent.substring(index + fullMatch.length);
        continue;
      }

      // Prevent circular includes
      if (visited.has(fullPath)) {
        throw new Error(`Circular include detected: ${fullPath}`);
      }

      // Mark as included globally
      included.add(fullPath);

      // Create new visited set for this child include (don't mutate parent's visited)
      const childVisited = new Set(visited);
      if (currentFile) {
        childVisited.add(currentFile);
      }

      // Load and process include file recursively with updated visited set and same included set
      let includedContent = await this.readShaderFile(fullPath);
      includedContent = await this.processIncludes(
        includedContent,
        childVisited,
        included,
        fullPath,
      );

      // Replace this specific occurrence using string position
      processedContent =
        processedContent.substring(0, index) +
        `\n${includedContent}\n` +
        processedContent.substring(index + fullMatch.length);
    }

    return processedContent;
  }

  public static async preprocessShader(shaderPath: string): Promise<string> {
    // Check cache first for the full processed shader
    const cached = this.processedShaderCache.get(shaderPath);
    if (cached) {
      return cached;
    }

    // Load and process shader
    const content = await this.readShaderFile(shaderPath);
    const processedContent = await this.processIncludes(content, new Set(), new Set(), shaderPath);

    // Cache the final processed shader
    this.processedShaderCache.set(shaderPath, processedContent);

    return processedContent;
  }

  /**
   * Clears the shader preprocessor cache.
   * Useful when shaders are modified or to prevent cache-related issues.
   */
  public static clearCache(): void {
    this.processedShaderCache.clear();
    this.includeFileCache.clear();
  }

  /**
   * Returns cache statistics for monitoring and debugging
   */
  public static getCacheStats(): { processedShaders: number; includeFiles: number } {
    return {
      processedShaders: this.processedShaderCache.size,
      includeFiles: this.includeFileCache.size,
    };
  }
}
