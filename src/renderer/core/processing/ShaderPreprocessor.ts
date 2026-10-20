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
    const response = await ResourceManager.fetch(`assets/shaders/${path}`);
    const content = await response.text();
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

  /**
   * Recursively pre-fetches all transitive #include files into the cache in parallel.
   * After this completes, every readShaderFile() call in processIncludes() is a cache hit.
   */
  private static async prefetchIncludes(path: string, visited: Set<string>): Promise<void> {
    if (visited.has(path)) return;
    visited.add(path);

    const content = await this.readShaderFile(path); // populates includeFileCache

    const includeRegex = /#include\s*["']([^"']+)["']/g;
    const childPaths: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = includeRegex.exec(content)) !== null) {
      const includePath = match[1];
      if (!includePath) continue;
      const fullPath = includePath.endsWith('.wgsl') ? includePath : `${includePath}.wgsl`;
      childPaths.push(fullPath);
    }

    // Fetch all children in parallel, and recurse into each in parallel
    await Promise.all(childPaths.map((p) => this.prefetchIncludes(p, visited)));
  }

  /**
   * Resolves includes and, with `defines`, the conditional blocks of a shader permutation:
   * `#ifdef NAME`, `#ifndef NAME`, `#else`, `#endif` (nestable, on their own line). Dropped
   * lines are blanked rather than removed so WGSL error line numbers still match the file.
   */
  public static async preprocessShader(
    shaderPath: string,
    defines: ReadonlyArray<string> = [],
  ): Promise<string> {
    const cacheKey = defines.length > 0 ? `${shaderPath}#${[...defines].sort().join(',')}` : shaderPath;
    const cached = this.processedShaderCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Pre-fetch all transitive #include files in parallel into the cache.
    // After this, every readShaderFile() call inside processIncludes() is a cache hit → instant.
    await this.prefetchIncludes(shaderPath, new Set());

    // Load and process shader (all reads are now cache hits)
    const content = await this.readShaderFile(shaderPath);
    const withIncludes = await this.processIncludes(content, new Set(), new Set(), shaderPath);
    const processedContent = this.applyDefines(withIncludes, new Set(defines), shaderPath);

    // Cache the final processed shader
    this.processedShaderCache.set(cacheKey, processedContent);

    return processedContent;
  }

  private static applyDefines(content: string, defines: ReadonlySet<string>, file: string): string {
    const directive = /^\s*#(ifdef|ifndef|else|endif)(?:\s+(\w+))?\s*$/;
    // One entry per open block: is this branch active, and was its parent active.
    const stack: Array<{ active: boolean; parentActive: boolean }> = [];
    let active = true;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = directive.exec(lines[i]!);
      if (m) {
        const kind = m[1];
        const name = m[2] ?? '';
        if (kind === 'ifdef' || kind === 'ifndef') {
          const cond = defines.has(name) === (kind === 'ifdef');
          stack.push({ active: active && cond, parentActive: active });
          active = active && cond;
        } else if (kind === 'else') {
          const top = stack[stack.length - 1];
          if (!top) throw new Error(`${file}: #else without #ifdef`);
          top.active = top.parentActive && !top.active;
          active = top.active;
        } else {
          const top = stack.pop();
          if (!top) throw new Error(`${file}: #endif without #ifdef`);
          active = top.parentActive;
        }
        lines[i] = '';
      } else if (!active) {
        lines[i] = '';
      }
    }
    if (stack.length > 0) throw new Error(`${file}: unterminated #ifdef`);
    return lines.join('\n');
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
