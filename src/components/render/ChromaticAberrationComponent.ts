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
import { ChromaticAberrationComponentData } from '../../types/ChromaticAberrationComponentData.type';

export class ChromaticAberrationComponent extends Component {
  private loaded = false;
  private device!: GPUDevice;

  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private result!: RenderTarget;

  private paramsBuffer!: GPUBuffer;
  private paramsData = new Float32Array(4); // [intensity, startOffset, 0, 0]

  private inputBindGroupCached: GPUBindGroup | null = null;
  private lastInputView: GPUTextureView | null = null;
  private paramsBindGroupCached: GPUBindGroup | null = null;

  private _editorFolder: any = null;

  private params = {
    enabled:     true,
    intensity:   0.5,
    startOffset: 0.0,
  };

  constructor() {
    super();
  }

  public async load(data: ChromaticAberrationComponentData = {}): Promise<void> {
    if (data.intensity    !== undefined) this.params.intensity    = data.intensity;
    if (data.startOffset  !== undefined) this.params.startOffset  = data.startOffset;

    this.device = Render.getInstance().getDevice();

    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('post-processing/chromatic_aberration.tech');

    const format = QualitySettings.getInstance().getSettings().aliasingTexture;
    this.result = new RenderTarget();
    this.result.createRT('ca_result', Render.canvasSize.width, Render.canvasSize.height, format);

    this.paramsBuffer = this.device.createBuffer({
      label: 'ca_params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.loaded = true;
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'chromatic_aberration', (comp) => {
      const c = comp as ChromaticAberrationComponent;
      if (c.hasLoaded()) c.resize();
    });
  }

  public resize(): void {
    if (!this.loaded) return;
    const format = QualitySettings.getInstance().getSettings().aliasingTexture;
    this.result.createRT('ca_result', Render.canvasSize.width, Render.canvasSize.height, format);
    this.inputBindGroupCached = null;
    this.lastInputView = null;
  }

  public apply(texture: GPUTextureView): GPUTextureView {
    if (!this.loaded || !this.params.enabled) return texture;

    this.uploadParams();

    if (!this.inputBindGroupCached || this.lastInputView !== texture) {
      this.inputBindGroupCached = BindGroupFactory.createBindGroup(
        'ca_input_bg',
        this.technique.getPipeline().getBindGroupLayout(0),
        [
          { binding: 0, resource: texture },
          { binding: 1, resource: SamplerLibrary.simpleSampler },
        ],
      );
      this.lastInputView = texture;
    }

    if (!this.paramsBindGroupCached) {
      this.paramsBindGroupCached = BindGroupFactory.createBindGroup(
        'ca_params_bg',
        this.technique.getPipeline().getBindGroupLayout(1),
        [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
      );
    }

    const encoder = Render.getInstance().getCommandEncoder();
    const pass = encoder.beginRenderPass({
      label: 'Chromatic Aberration',
      colorAttachments: [
        {
          view: this.result.getRenderView(),
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: 'store',
        },
      ],
    });

    this.technique.activatePipeline(pass);
    this.fullscreenQuadMesh.activate(pass);
    pass.setBindGroup(0, this.inputBindGroupCached!);
    pass.setBindGroup(1, this.paramsBindGroupCached!);
    this.fullscreenQuadMesh.renderGroup(pass);
    pass.end();

    return this.result.getView();
  }

  private uploadParams(): void {
    this.paramsData[0] = this.params.intensity;
    this.paramsData[1] = this.params.startOffset;
    this.paramsData[2] = 0.0;
    this.paramsData[3] = 0.0;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.paramsData);
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }

  public update(_dt: number): void {}

  public override renderInMenu(parentFolder?: any): void {
    if (!parentFolder) return;
    if (this._editorFolder) return;
    this._editorFolder = parentFolder.addFolder('Chromatic Aberration');
    this._editorFolder.close();
    this._editorFolder.add(this.params, 'enabled').name('Enabled').listen();
    this._editorFolder.add(this.params, 'intensity', 0.0, 5.0, 0.05).name('Intensity').listen();
    this._editorFolder
      .add(this.params, 'startOffset', 0.0, 1.0, 0.01)
      .name('Start Offset')
      .listen();
  }

  public debugInMenu(): void {}
  public renderDebug(): void {}

  public override dispose(): void {
    this.result?.destroy();
    this.paramsBuffer?.destroy();
  }
}
