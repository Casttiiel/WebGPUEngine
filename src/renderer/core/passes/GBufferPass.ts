import { RenderTarget } from '../../resources/RenderTarget';
import { Render } from '../pipeline/Render';
import { QualitySettings } from '../../../core/engine/QualitySettings';

/**
 * G-Buffer render pass for deferred rendering
 * Renders geometry to multiple render targets (albedo, normal octahedral, linear depth)
 */
export class GBufferPass {
  private rtAlbedos!: RenderTarget;
  private rtNormals!: RenderTarget;
  private rtLinearDepth!: RenderTarget;

  constructor() {
    // Empty constructor
  }

  public load(): void {
    this.createRenderTargets();
  }

  private createRenderTargets(): void {
    const width = Render.width;
    const height = Render.height;

    console.log(`Creating G-Buffer targets at ${width}x${height}`);

    // Create G-Buffer render targets
    this.rtAlbedos = new RenderTarget();
    this.rtAlbedos.createRT(
      'gbuffer_albedos',
      width,
      height,
      QualitySettings.getInstance().getSettings().albedoTexture,
      GPUTextureUsage.COPY_SRC,
    );

    this.rtNormals = new RenderTarget();
    this.rtNormals.createRT(
      'gbuffer_normals',
      width,
      height,
      QualitySettings.getInstance().getSettings().normalTexture,
      GPUTextureUsage.COPY_SRC,
    );

    this.rtLinearDepth = new RenderTarget();
    this.rtLinearDepth.createRT(
      'gbuffer_linear_depth',
      width,
      height,
      QualitySettings.getInstance().getSettings().linearDepthTexture,
      GPUTextureUsage.COPY_SRC,
    );
  }

  public getRenderTargets(): {
    albedos: RenderTarget;
    normals: RenderTarget;
    linearDepth: RenderTarget;
  } {
    return {
      albedos: this.rtAlbedos,
      normals: this.rtNormals,
      linearDepth: this.rtLinearDepth,
    };
  }

  public resize(): void {
    this.dispose();
    this.createRenderTargets();
  }

  public dispose(): void {
    this.rtAlbedos?.destroy();
    this.rtNormals?.destroy();
    this.rtLinearDepth?.destroy();
  }
}
