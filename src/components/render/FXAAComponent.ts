import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';

export class FXAAComponent extends Component {
  private loaded = false;
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private result!: RenderTarget;
  private renderPassManager!: RenderPassManager;

  // ✅ Cache bind groups per texture to avoid recreation every frame
  private bindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();

  // FXAA parameters that can be tweaked
  private fxaaParams = {
    enabled: true,
    subPixelShift: 0.25,
    edgeThreshold: 0.063,
    edgeThresholdMin: 0.0312,
  };


  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('post-processing/fxaa.tech');

    const aliasingFormat = QualitySettings.getInstance().getSettings().aliasingTexture;

    this.result = new RenderTarget();
    this.result.createRT(
      'fxaa_result.dds',
      Render.canvasSize.width,
      Render.canvasSize.height,
      aliasingFormat,
    );

    this.loaded = true;
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'fxaa', (comp) => {
      const c = comp as FXAAComponent;
      if (c.hasLoaded()) c.resize();
    });
  }

  public resize(): void {
    const aliasingFormat = QualitySettings.getInstance().getSettings().aliasingTexture;

    this.result.createRT(
      'fxaa_result.dds',
      Render.canvasSize.width,
      Render.canvasSize.height,
      aliasingFormat,
    );
    // ✅ Clear cache on resize
    this.bindGroupCache.clear();
  }

  public apply(texture: GPUTextureView): GPUTextureView {
    const bindGroup = this.getOrCreateBindGroup(texture);

    // Use RenderPassManager to execute FXAA pass dynamically
    this.renderPassManager.executeAntialiasingPass(
      this.fullscreenQuadMesh,
      this.technique,
      bindGroup,
      this.result,
      'FXAA',
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
        `fxaa_bindgroup`,
        this.technique.getPipeline().getBindGroupLayout(1),
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

  public override renderInMenu(folder?: any): void {
    if (!folder) return;
    if (this._editorFolder) return;
    this._editorFolder = folder.addFolder('FXAA');
    this._editorFolder.close();
    this._editorFolder.add(this.fxaaParams, 'enabled').name('Enabled').listen();
    this._editorFolder
      .add(this.fxaaParams, 'subPixelShift', 0.0, 1.0, 0.01)
      .name('Sub-pixel Shift')
      .listen();
    this._editorFolder
      .add(this.fxaaParams, 'edgeThreshold', 0.0, 0.5, 0.001)
      .name('Edge Threshold')
      .listen();
    this._editorFolder
      .add(this.fxaaParams, 'edgeThresholdMin', 0.0, 0.1, 0.001)
      .name('Edge Threshold Min')
      .listen();
  }

  public debugInMenu(): void {
    // Implement debug menu if needed
  }

  public renderDebug(): void {
    // Implement debug rendering if needed
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }
}
