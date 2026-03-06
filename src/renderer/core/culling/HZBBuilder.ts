import { ResourceManager } from '../../../core/engine/ResourceManager';
import { BindGroupFactory } from '../factories/BindGroupFactory';
import { PipelineFactory } from '../factories/PipelineFactory';
import { GPUUtils } from '../utils/GPUUtils';

// ---- Constants ---------------------------------------------------------------

/** Maximum mip levels supported (covers up to 32768×32768). */
const MAX_MIPS = 16;

/**
 * Hierarchical Z-Buffer Builder
 *
 * Builds a max-depth mip pyramid (r32float) from the frame's depth prepass
 * texture.  The pyramid is used the following frame by HZBCullingPass to
 * perform per-object occlusion culling entirely on the GPU with zero CPU
 * readback.
 *
 * Pipeline:
 *   1. Copy depth (depth32float → HZB mip 0, r32float storage texture).
 *   2. Downsample mip chain (N → N+1) taking MAX of each 2×2 block.
 *
 * Usage (inside DeferredRenderer):
 *   await hzbBuilder.initialize();          // once at startup (loads shaders)
 *   hzbBuilder.createResources(w, h, depthTexture); // on resize
 *   // per frame, AFTER executePass('gbuffer'):
 *   hzbBuilder.build(encoder, depthTexture);
 */
export class HZBBuilder {
  private device!: GPUDevice;

  // ---- Copy depth pipeline --------------------------------------------------
  private copyPipeline!: GPUComputePipeline;
  private copyLayout!: GPUBindGroupLayout;
  private copyBindGroup: GPUBindGroup | null = null;

  // ---- Downsample pipeline --------------------------------------------------
  private downsamplePipeline!: GPUComputePipeline;
  private downsampleLayout!: GPUBindGroupLayout;
  /** One uniform buffer per mip transition (srcW / srcH, 16 bytes each). */
  private downsampleParamsBuffers: GPUBuffer[] = [];
  /** One bind group per mip transition. */
  private downsampleBindGroups: GPUBindGroup[] = [];

  // ---- HZB texture ----------------------------------------------------------
  private hzbTexture: GPUTexture | null = null;
  /** Full mip-chain view used by the HZB culling shader. */
  private hzbSampledView: GPUTextureView | null = null;
  /** Per-mip write views (baseMipLevel = i, mipLevelCount = 1). */
  private hzbMipWriteViews: GPUTextureView[] = [];
  /** Per-mip read views (single mip, for downsample source binding). */
  private hzbMipReadViews: GPUTextureView[] = [];

  private hzbWidth = 0;
  private hzbHeight = 0;
  private mipCount = 0;

  private initialized = false;
  /** True once at least one build() completed — enables HZB culling next frame. */
  private hasBuiltFrame = false;
  /** Tracks the depth texture so we know when to rebuild bind groups on resize. */
  private lastDepthTexture: GPUTexture | null = null;

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  public async initialize(): Promise<void> {
    this.device = GPUUtils.getDevice();

    await this.createCopyPipeline();
    await this.createDownsamplePipeline();

    this.initialized = true;
  }

  private async createCopyPipeline(): Promise<void> {
    const shaderCode = await ResourceManager.loadShader('utility/hzb_build_copy.cs');

    // Layout:
    //   binding 0 — texture_depth_2d  (depth prepass, read-only texture)
    //   binding 1 — texture_storage_2d<r32float, write> (HZB mip 0)
    this.copyLayout = BindGroupFactory.getLayout('hzb_build_copy_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'depth', viewDimension: '2d' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '2d' },
      },
    ]);

    const module = this.device.createShaderModule({
      label: 'hzb_build_copy_shader',
      code: shaderCode,
    });

    const layout = PipelineFactory.createPipelineLayout('hzb_build_copy_pipeline_layout', [
      this.copyLayout,
    ]);

    this.copyPipeline = PipelineFactory.createComputePipeline({
      label: 'hzb_build_copy_pipeline',
      layout,
      compute: { module, entryPoint: 'main' },
    });
  }

  private async createDownsamplePipeline(): Promise<void> {
    const shaderCode = await ResourceManager.loadShader('utility/hzb_build_downsample.cs');

    // Layout:
    //   binding 0 — uniform  (DownsampleParams: srcMipWidth, srcMipHeight, pad×2)
    //   binding 1 — texture_2d<f32>  (previous mip, r32float → unfilterable-float)
    //   binding 2 — texture_storage_2d<r32float, write>  (next mip)
    this.downsampleLayout = BindGroupFactory.getLayout('hzb_build_downsample_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '2d' },
      },
    ]);

    const module = this.device.createShaderModule({
      label: 'hzb_build_downsample_shader',
      code: shaderCode,
    });

    const layout = PipelineFactory.createPipelineLayout('hzb_build_downsample_pipeline_layout', [
      this.downsampleLayout,
    ]);

    this.downsamplePipeline = PipelineFactory.createComputePipeline({
      label: 'hzb_build_downsample_pipeline',
      layout,
      compute: { module, entryPoint: 'main' },
    });
  }

  // --------------------------------------------------------------------------
  // Resource creation / resize
  // --------------------------------------------------------------------------

  /**
   * Creates (or recreates) the HZB texture and all per-mip bind groups.
   * Must be called once at startup and again whenever the render resolution changes.
   *
   * @param depthTexture   The depth prepass GPUTexture (depth32float).
   */
  public createResources(depthTexture: GPUTexture): void {
    if (!this.initialized) return;

    this.disposeTextures();

    // Derive HZB dimensions from the depth texture
    this.hzbWidth = depthTexture.width;
    this.hzbHeight = depthTexture.height;
    this.mipCount = Math.min(
      Math.floor(Math.log2(Math.max(this.hzbWidth, this.hzbHeight))) + 1,
      MAX_MIPS,
    );

    // Create r32float texture with the full mip chain
    this.hzbTexture = GPUUtils.createTextureWithMipmaps(
      'hzb_pyramid',
      this.hzbWidth,
      this.hzbHeight,
      'r32float',
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      this.mipCount,
    );

    // Full mip-chain view for sampling in HZBCullingPass
    this.hzbSampledView = this.hzbTexture.createView({
      label: 'hzb_sampled_view',
      format: 'r32float',
      dimension: '2d',
      baseMipLevel: 0,
      mipLevelCount: this.mipCount,
    });

    // Per-mip views
    this.hzbMipWriteViews = [];
    this.hzbMipReadViews = [];
    for (let i = 0; i < this.mipCount; i++) {
      this.hzbMipWriteViews.push(
        this.hzbTexture.createView({
          label: `hzb_mip${i}_write`,
          format: 'r32float',
          dimension: '2d',
          baseMipLevel: i,
          mipLevelCount: 1,
        }),
      );
      this.hzbMipReadViews.push(
        this.hzbTexture.createView({
          label: `hzb_mip${i}_read`,
          format: 'r32float',
          dimension: '2d',
          baseMipLevel: i,
          mipLevelCount: 1,
        }),
      );
    }

    // Rebuild all bind groups
    this.rebuildBindGroups(depthTexture);
    this.lastDepthTexture = depthTexture;
    this.hasBuiltFrame = false; // Invalidate until first build completes
  }

  /** Rebuilds the copy + downsample bind groups. */
  private rebuildBindGroups(depthTexture: GPUTexture): void {
    // ---- Copy bind group ---------------------------------------------------
    const depthView = depthTexture.createView({
      label: 'hzb_depth_src_view',
      aspect: 'depth-only',
      dimension: '2d',
      baseMipLevel: 0,
      mipLevelCount: 1,
    });

    this.copyBindGroup = this.device.createBindGroup({
      label: 'hzb_copy_bind_group',
      layout: this.copyLayout,
      entries: [
        { binding: 0, resource: depthView },
        { binding: 1, resource: this.hzbMipWriteViews[0]! },
      ],
    });

    // ---- Downsample bind groups (one per mip transition) -------------------
    // Old params buffers are destroyed in disposeTextures(); allocate fresh ones.
    this.downsampleParamsBuffers = [];
    this.downsampleBindGroups = [];

    let w = this.hzbWidth;
    let h = this.hzbHeight;

    for (let i = 1; i < this.mipCount; i++) {
      // The source of mip i is mip i-1 with dimensions (w, h).
      const paramsData = new Uint32Array([w, h, 0, 0]);
      const paramsBuffer = this.device.createBuffer({
        label: `hzb_downsample_params_mip${i}`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(paramsBuffer, 0, paramsData);
      this.downsampleParamsBuffers.push(paramsBuffer);

      this.downsampleBindGroups.push(
        this.device.createBindGroup({
          label: `hzb_downsample_bg_mip${i}`,
          layout: this.downsampleLayout,
          entries: [
            { binding: 0, resource: { buffer: paramsBuffer } },
            { binding: 1, resource: this.hzbMipReadViews[i - 1]! },
            { binding: 2, resource: this.hzbMipWriteViews[i]! },
          ],
        }),
      );

      // Next mip is half the size (floored)
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }
  }

  // --------------------------------------------------------------------------
  // Per-frame build
  // --------------------------------------------------------------------------

  /**
   * Builds the full HZB mip pyramid from the depth prepass texture.
   * Must be called AFTER the GBuffer render pass and BEFORE endFrame().
   *
   * @param encoder       The current frame command encoder.
   * @param depthTexture  The depth prepass GPUTexture (depth32float).
   */
  public build(encoder: GPUCommandEncoder, depthTexture: GPUTexture): void {
    if (!this.initialized || !this.hzbTexture || !this.copyBindGroup) return;

    // If the depth texture changed (e.g. after resize), rebuild bind groups.
    if (depthTexture !== this.lastDepthTexture) {
      this.rebuildBindGroups(depthTexture);
      this.lastDepthTexture = depthTexture;
    }

    // ---- Pass 0: copy depth → HZB mip 0 ------------------------------------
    {
      const wg = Math.ceil(this.hzbWidth / 8);
      const hg = Math.ceil(this.hzbHeight / 8);

      const pass = encoder.beginComputePass({ label: 'hzb_build_copy' });
      pass.setPipeline(this.copyPipeline);
      pass.setBindGroup(0, this.copyBindGroup);
      pass.dispatchWorkgroups(wg, hg, 1);
      pass.end();
    }

    // ---- Passes 1..N: downsample mip chain ----------------------------------
    let srcW = this.hzbWidth;
    let srcH = this.hzbHeight;

    for (let i = 1; i < this.mipCount; i++) {
      const dstW = Math.max(1, Math.floor(srcW / 2));
      const dstH = Math.max(1, Math.floor(srcH / 2));
      const wg = Math.ceil(dstW / 8);
      const hg = Math.ceil(dstH / 8);

      const pass = encoder.beginComputePass({ label: `hzb_build_downsample_mip${i}` });
      pass.setPipeline(this.downsamplePipeline);
      pass.setBindGroup(0, this.downsampleBindGroups[i - 1]!);
      pass.dispatchWorkgroups(wg, hg, 1);
      pass.end();

      srcW = dstW;
      srcH = dstH;
    }

    this.hasBuiltFrame = true;
  }

  // --------------------------------------------------------------------------
  // Accessors
  // --------------------------------------------------------------------------

  /** Full mip-chain view of the HZB texture (use in HZBCullingPass). */
  public getHZBView(): GPUTextureView | null {
    return this.hzbSampledView;
  }

  /** Number of mip levels in the pyramid. */
  public getMipCount(): number {
    return this.mipCount;
  }

  /** Full-resolution width of the HZB texture. */
  public getWidth(): number {
    return this.hzbWidth;
  }

  /** Full-resolution height of the HZB texture. */
  public getHeight(): number {
    return this.hzbHeight;
  }

  /**
   * True once at least one HZB build has completed.
   * The first frame cannot use HZB culling because there is no previous-frame depth.
   */
  public isReady(): boolean {
    return this.hasBuiltFrame && this.hzbTexture !== null;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  private disposeTextures(): void {
    this.hzbTexture?.destroy();
    this.hzbTexture = null;
    this.hzbSampledView = null;
    this.copyBindGroup = null;
    this.hzbMipWriteViews = [];
    this.hzbMipReadViews = [];

    for (const buf of this.downsampleParamsBuffers) {
      buf.destroy();
    }
    this.downsampleParamsBuffers = [];
    this.downsampleBindGroups = [];
    this.lastDepthTexture = null;
  }

  public dispose(): void {
    this.disposeTextures();
    this.initialized = false;
    this.hasBuiltFrame = false;
  }
}
