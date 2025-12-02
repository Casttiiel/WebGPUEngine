import { GPUUtils } from '../utils/GPUUtils';
import { Render } from '../pipeline/Render';

/**
 * Depth prepass for deferred rendering
 * Generates depth and linear depth textures before G-Buffer rendering
 * This allows:
 * 1. Early depth rejection in G-Buffer pass
 * 2. Single depth buffer shared across multiple passes
 * 3. Linear depth available for effects without regenerating
 */
export class DepthPrepass {
  private depthTexture!: GPUTexture;
  private depthTextureView!: GPUTextureView;

  constructor() {
    // Empty constructor
  }

  public load(): void {
    this.createResources();
  }

  private createResources(): void {
    const width = Render.width;
    const height = Render.height;

    // Create depth texture
    this.depthTexture = GPUUtils.createTexture(
      'depth_prepass_texture',
      width,
      height,
      'depth32float',
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    );
    this.depthTextureView = this.depthTexture.createView({
      aspect: 'depth-only',
    });
  }

  /**
   * Get depth texture for use in G-Buffer and other passes
   */
  public getDepthTexture(): GPUTexture {
    return this.depthTexture;
  }

  /**
   * Get depth texture view for render passes
   */
  public getDepthTextureView(): GPUTextureView {
    return this.depthTextureView;
  }

  public resize(): void {
    this.dispose();
    this.createResources();
  }

  public dispose(): void {
    this.depthTexture?.destroy();
  }
}
