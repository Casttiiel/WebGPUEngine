import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';

export class ToneMappingComponent extends Component {
  private isLoaded = false;
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private result!: RenderTarget;
  private renderPassManager!: RenderPassManager;

  // ✅ Cache bind groups per texture to avoid recreation every frame
  private bindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();
  /** Fallback 1.0 exposure buffer — always set so group 1 is never missing. */
  private defaultExposureBuffer!: GPUBuffer;
  private exposureBindGroup!: GPUBindGroup;
  private trackedExposureBuffer: GPUBuffer | null = null;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('post-processing/tone_mapping.tech');

    const toneMappingFormat = QualitySettings.getInstance().getSettings().toneMappingTexture;

    this.result = new RenderTarget();
    this.result.createRT('tone_mapping_result.dds', Render.width, Render.height, toneMappingFormat);

    // ✅ Create a fallback exposure buffer (1.0 = no adaptation) so group 1 is
    //    always bound even when AutoExposureComponent is absent.
    this.defaultExposureBuffer = GPUUtils.createBuffer(
      'tonemapping_default_exposure_buffer',
      4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    Render.getInstance()
      .getDevice()
      .queue.writeBuffer(this.defaultExposureBuffer, 0, new Float32Array([1.0]));
    this.exposureBindGroup = BindGroupFactory.createBindGroup(
      'tonemapping_default_exposure_bindgroup',
      this.technique.getPipeline().getBindGroupLayout(1),
      [{ binding: 0, resource: { buffer: this.defaultExposureBuffer } }],
    );

    this.isLoaded = true;
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'tone_mapping', (comp) => {
      const c = comp as ToneMappingComponent;
      if (c.hasLoaded()) c.resize();
    });
  }

  public resize(): void {
    const toneMappingFormat = QualitySettings.getInstance().getSettings().toneMappingTexture;

    this.result.createRT('tone_mapping_result.dds', Render.width, Render.height, toneMappingFormat);
    // ✅ Clear cache on resize (textures recreated)
    this.bindGroupCache.clear();
    // Note: exposureBindGroup is not texture-dependent, no need to clear it
  }

  /**
   * Resize the output RT to explicit dimensions.
   * Called by ModuleRender when an upstream pass (e.g. TSR) has already
   * upscaled the result to canvas resolution before tone mapping runs.
   */
  public setOutputSize(width: number, height: number): void {
    const toneMappingFormat = QualitySettings.getInstance().getSettings().toneMappingTexture;
    if (this.result.getWidth() === width && this.result.getHeight() === height) return;
    this.result.createRT('tone_mapping_result.dds', width, height, toneMappingFormat);
    this.bindGroupCache.clear();
  }

  /**
   * Provide the GPU buffer written by AutoExposureComponent so tone mapping
   * reads the current adapted exposure value.
   * Call once after AutoExposureComponent is loaded; the bind group is cached.
   */
  public setExposureBuffer(exposureBuffer: GPUBuffer): void {
    if (exposureBuffer === this.trackedExposureBuffer) return; // No change
    this.trackedExposureBuffer = exposureBuffer;
    this.exposureBindGroup = BindGroupFactory.createBindGroup(
      'tonemapping_exposure_bindgroup',
      this.technique.getPipeline().getBindGroupLayout(1),
      [{ binding: 0, resource: { buffer: exposureBuffer } }],
    );
  }

  public apply(texture: GPUTextureView): GPUTextureView {
    const bindGroup = this.getOrCreateBindGroup(texture);

    // Use RenderPassManager to execute tone mapping pass dynamically
    this.renderPassManager.executeToneMappingPass(
      this.fullscreenQuadMesh,
      this.technique,
      bindGroup,
      this.result,
      this.exposureBindGroup,
    );

    return this.result.getView();
  }

  /**
   * ✅ Get or create cached bind group for texture (avoids recreation every frame)
   */
  private getOrCreateBindGroup(texture: GPUTextureView): GPUBindGroup {
    let bindGroup = this.bindGroupCache.get(texture);
    if (!bindGroup) {
      const sampler = SamplerLibrary.simpleSampler;

      bindGroup = BindGroupFactory.createBindGroup(
        `tonemapping_bindgroup`,
        this.technique.getPipeline().getBindGroupLayout(0),
        [
          {
            binding: 0,
            resource: texture,
          },
          {
            binding: 1,
            resource: sampler,
          },
        ],
      );
      this.bindGroupCache.set(texture, bindGroup);
    }
    return bindGroup;
  }
  public update(_dt: number): void {
    throw new Error('Method not implemented.');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override renderInMenu(folder?: any): void {
    if (!folder) return;
    if (this._editorFolder) return;

    this._editorFolder = folder.addFolder('Tone Mapping');
    this._editorFolder.close();

    const proxy = {
      technique: 'tone_mapping.tech',
      loaded: this.isLoaded,
    };
    this._editorFolder.add(proxy, 'loaded').name('Loaded').disable();
    this._editorFolder.add(proxy, 'technique').name('Technique').disable();
  }

  public debugInMenu(): void {
    // Implement debug menu if needed
  }

  public renderDebug(): void {
    // Implement debug rendering if needed
  }

  public hasLoaded(): boolean {
    return this.isLoaded;
  }
}
