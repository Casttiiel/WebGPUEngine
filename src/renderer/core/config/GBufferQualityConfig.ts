/**
 * G-Buffer Texture Quality Configuration
 * Maps quality settings to optimal texture formats for different hardware capabilities
 */

export interface GBufferFormats {
  albedo: GPUTextureFormat;      // Base color + metallic
  normal: GPUTextureFormat;      // World normal + roughness  
  selfIllum: GPUTextureFormat;   // Emissive color
  linearDepth: GPUTextureFormat; // Linear depth for position reconstruction
}

export class GBufferQualityConfig {
  /**
   * Get G-Buffer texture formats based on quality setting
   */
  public static getFormats(quality: 'low' | 'medium' | 'high'): GBufferFormats {
    switch (quality) {
      case 'low':
        return {
          // 8-bit formats for maximum compatibility and performance
          albedo: 'rgba8unorm',       // 32 bits total (8x4)
          normal: 'rgba8unorm',       // 32 bits total (8x4) 
          selfIllum: 'rgba8unorm',    // 32 bits total (8x4)
          linearDepth: 'rg16float',   // 32 bits, guaranteed filterable for WebGPU
        };
        
      case 'medium':
        return {
          // Mixed precision - balance between quality and performance
          albedo: 'rgba8unorm',       // 32 bits - albedo doesn't need high precision
          normal: 'rgba16float',      // 64 bits - normals benefit from higher precision
          selfIllum: 'rgba8unorm',    // 32 bits - emissive can use lower precision
          linearDepth: 'rg16float',   // 32 bits - compatible with MSAA resolve and filterable
        };
        
      case 'high':
        return {
          // High precision formats for best quality
          albedo: 'rgba16float',      // 64 bits total (16x4)
          normal: 'rgba16float',      // 64 bits total (16x4)
          selfIllum: 'rgba16float',   // 64 bits total (16x4) 
          linearDepth: 'rg16float',   // 32 bits - max compatible precision for depth, filterable
        };
        
      default:
        // Fallback to medium quality
        return this.getFormats('medium');
    }
  }

  /**
   * Get memory usage estimation in MB for a given resolution and quality
   */
  public static getMemoryUsage(
    width: number, 
    height: number, 
    quality: 'low' | 'medium' | 'high',
    msaaLevel: number = 1
  ): number {
    const formats = this.getFormats(quality);
    const pixels = width * height;
    
    // Calculate bytes per pixel for each format
    const getBytesPerPixel = (format: GPUTextureFormat): number => {
      switch (format) {
        case 'rgba8unorm': return 4;   // 8 bits × 4 channels
        case 'rgba16float': return 8;  // 16 bits × 4 channels  
        case 'r16float': return 2;     // 16 bits × 1 channel
        case 'rg16float': return 4;    // 16 bits × 2 channels
        case 'r32float': return 4;     // 32 bits × 1 channel (fallback, not used now)
        default: return 4;
      }
    };
    
    const totalBytes = 
      getBytesPerPixel(formats.albedo) +
      getBytesPerPixel(formats.normal) +
      getBytesPerPixel(formats.selfIllum) +
      getBytesPerPixel(formats.linearDepth);
    
    // Account for MSAA multiplier
    const msaaMultiplier = msaaLevel > 1 ? msaaLevel : 1;
    
    // Calculate total memory in MB
    const totalMemoryBytes = pixels * totalBytes * msaaMultiplier;
    return totalMemoryBytes / (1024 * 1024);
  }

}
