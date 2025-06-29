import { RenderTarget } from '../../resources/RenderTarget';
import { GPUUtils } from '../utils/GPUUtils';
import { Render } from '../Render';
import { QualitySettings } from '../../../core/engine/QualitySettings';

/**
 * G-Buffer render pass for deferred rendering
 * Renders geometry to multiple render targets (albedo, normal, depth, etc.)
 */
export class GBufferPass {
  private rtAlbedos!: RenderTarget;
  private rtNormals!: RenderTarget;
  private rtSelfIllum!: RenderTarget;
  private rtLinearDepth!: RenderTarget;
  private depthStencil!: GPUTexture;
  private depthStencilView!: GPUTextureView;
  private msaaDepthStencil!: GPUTexture;
  private msaaDepthStencilView!: GPUTextureView | null;

  constructor() {
    // Empty constructor
  }

  public load(): void {
    this.createRenderTargets();
  }

  private createRenderTargets(): void {
    const width = Render.width;
    const height = Render.height;
    const qualitySettings = QualitySettings.getInstance();
    const msaaLevel = qualitySettings.getMSAALevel();
    const enableMSAA = msaaLevel > 0;
    
    // Create G-Buffer render targets with formats matching gbuffer.tech pipeline
    this.rtAlbedos = new RenderTarget();
    this.rtAlbedos.createRT('gbuffer_albedos', width, height, 'rgba16float', enableMSAA);

    this.rtNormals = new RenderTarget();
    this.rtNormals.createRT('gbuffer_normals', width, height, 'rgba16float', enableMSAA);

    this.rtSelfIllum = new RenderTarget();
    this.rtSelfIllum.createRT('gbuffer_selfillum', width, height, 'rgba16float', enableMSAA);

    this.rtLinearDepth = new RenderTarget();
    this.rtLinearDepth.createRT('gbuffer_linear_depth', width, height, 'r16float', enableMSAA);
    
    // Create depth buffers (both MSAA and single-sample)
    this.depthStencil = GPUUtils.createTexture(
      'gbuffer_depth_single',
      width,
      height,
      'depth32float',
      GPUTextureUsage.RENDER_ATTACHMENT,
    );
    this.depthStencilView = this.depthStencil.createView({
      aspect: 'depth-only',
    });

    if (enableMSAA) {
      this.msaaDepthStencil = GPUUtils.createTexture(
        'gbuffer_depth_msaa',
        width,
        height,
        'depth32float',
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        msaaLevel,
      );
      this.msaaDepthStencilView = this.msaaDepthStencil.createView({
        aspect: 'depth-only',
      });
    } else {
      // When MSAA is disabled, use the single-sample depth texture for both
      this.msaaDepthStencil = this.depthStencil;
      this.msaaDepthStencilView = this.depthStencilView;
    }
  }

  public execute(
    encoder: GPUCommandEncoder,
    renderCallback: (pass: GPURenderPassEncoder) => void,
  ): void {
    const colorAttachments: GPURenderPassColorAttachment[] = [
      GPUUtils.createColorAttachment(this.rtAlbedos.getRenderView(), 'clear'),
      GPUUtils.createColorAttachment(this.rtNormals.getRenderView(), 'clear'),
      GPUUtils.createColorAttachment(this.rtSelfIllum.getRenderView(), 'clear'),
      GPUUtils.createColorAttachment(this.rtLinearDepth.getRenderView(), 'clear'),
    ];

    // Add resolve targets for MSAA if available
    const albedoResolve = this.rtAlbedos.getResolveTarget();
    const normalResolve = this.rtNormals.getResolveTarget();
    const selfIllumResolve = this.rtSelfIllum.getResolveTarget();
    const linearDepthResolve = this.rtLinearDepth.getResolveTarget();
    if (albedoResolve) colorAttachments[0]!.resolveTarget = albedoResolve;
    if (normalResolve) colorAttachments[1]!.resolveTarget = normalResolve;
    if (selfIllumResolve) colorAttachments[2]!.resolveTarget = selfIllumResolve;
    if (linearDepthResolve) colorAttachments[3]!.resolveTarget = linearDepthResolve;

    const depthStencilAttachment = GPUUtils.createDepthStencilAttachment(
      this.msaaDepthStencilView!,
      'clear',
      'store',
    );

    const passDescriptor: GPURenderPassDescriptor = {
      label: 'G-Buffer Pass',
      colorAttachments,
      depthStencilAttachment,
    };

    const pass = encoder.beginRenderPass(passDescriptor);

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(pass);

    renderCallback(pass);
    pass.end();
  }

  public getRenderTargets(): {
    albedos: RenderTarget;
    normals: RenderTarget;
    selfIllum: RenderTarget;
    linearDepth: RenderTarget;
  } {
    return {
      albedos: this.rtAlbedos,
      normals: this.rtNormals,
      selfIllum: this.rtSelfIllum,
      linearDepth: this.rtLinearDepth,
    };
  }

  public getDepthTextures(): {
    msaaDepth: GPUTexture;
    singleDepth: GPUTexture;
    msaaDepthView: GPUTextureView;
    singleDepthView: GPUTextureView;
  } {
    return {
      msaaDepth: this.msaaDepthStencil,
      singleDepth: this.depthStencil,
      msaaDepthView: this.msaaDepthStencilView!,
      singleDepthView: this.depthStencilView,
    };
  }

  public async resize(): Promise<void> {
    this.dispose();
    await this.createRenderTargets();
  }

  public dispose(): void {
    this.rtAlbedos?.destroy();
    this.rtNormals?.destroy();
    this.rtSelfIllum?.destroy();
    this.rtLinearDepth?.destroy();
    this.depthStencil?.destroy();
    this.msaaDepthStencil?.destroy();
  }
}
