export class ShaderPreprocessor {
  private static cache: Map<string, string> = new Map();

  private static async readShaderFile(path: string): Promise<string> {
    return await fetch(`/assets/shaders/${path}`).then((res) => res.text());
  }

  private static async processIncludes(
    content: string,
    visited: Set<string> = new Set(),
  ): Promise<string> {
    const includeRegex = /#include\s*["']([^"']+)["']/g;
    let processedContent = content;
    let match: RegExpExecArray | null;

    while ((match = includeRegex.exec(content)) !== null) {
      const [fullMatch, includePath] = match;
      if (!includePath) continue;

      const fullPath = includePath.endsWith('.wgsl') ? includePath : `${includePath}.wgsl`;

      // Prevent circular includes
      if (visited.has(fullPath)) {
        throw new Error(`Circular include detected: ${fullPath}`);
      }

      // Try cache first
      let includedContent = this.cache.get(fullPath);
      if (!includedContent) {
        includedContent = await this.readShaderFile(fullPath);

        // Process nested includes in the included content
        const newVisited = new Set(visited);
        newVisited.add(fullPath);
        includedContent = await this.processIncludes(includedContent, newVisited);

        this.cache.set(fullPath, includedContent);
      }

      // Add newlines and proper indentation
      processedContent = processedContent.replace(fullMatch, `\n${includedContent}\n`);
    }

    return processedContent;
  }

  public static async preprocessShader(shaderPath: string): Promise<string> {
    // Check cache first for the full processed shader
    const cached = this.cache.get(shaderPath);
    if (cached) {
      return cached;
    }

    // Load and process shader
    const content = await this.readShaderFile(shaderPath);
    const processedContent = await this.processIncludes(content);

    // Cache the final processed shader
    this.cache.set(shaderPath, processedContent);

    return processedContent;
  }
}
