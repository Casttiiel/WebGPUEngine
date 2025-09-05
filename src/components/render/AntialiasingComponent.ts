import { Component } from '../../core/ecs/Component';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { Engine } from '../../core/engine/Engine';

export class AntialiasingComponent extends Component {
  private loaded = false;
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private bindGroup!: GPUBindGroup | null;
  private result!: RenderTarget;
  private renderPassManager!: RenderPassManager;

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
    this.technique = await Technique.getAsync('antialiasing.tech');

    const aliasingFormat = QualitySettings.getInstance().getSettings().aliasingTexture;

    this.result = new RenderTarget();
    this.result.createRT('antialiasing_result.dds', Render.width, Render.height, aliasingFormat);

    this.loaded = true;
  }

  public resize(): void {
    const aliasingFormat = QualitySettings.getInstance().getSettings().aliasingTexture;

    this.result.createRT('antialiasing_result.dds', Render.width, Render.height, aliasingFormat);
    this.bindGroup = null;
  }

  public apply(texture: GPUTextureView): GPUTextureView {
    this.createBindGroup(texture);

    // Use RenderPassManager to execute antialiasing pass dynamically
    this.renderPassManager.executeAntialiasingPass(
      this.fullscreenQuadMesh,
      this.technique,
      this.bindGroup!,
      this.result,
    );

    return this.result.getView();
  }

  private createBindGroup(texture: GPUTextureView): void {
    if (this.bindGroup) return;

    const sampler = SamplerLibrary.simpleSampler;

    this.bindGroup = BindGroupFactory.createBindGroup(
      `antialiasing_bindgroup`,
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
  }

  public update(_dt: number): void {
    throw new Error('Method not implemented.');
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const parentFolder = 'render';
    const subfolderKey = 'Camera Components';
    const componentName = 'Antialiasing';

    // Add controls to the Camera Components subfolder
    const addControl = (object: unknown, propertyKey: string, label: string, options?: any) => {
      debugUI.addControlToSubFolder(parentFolder, subfolderKey, object, propertyKey, label, {
        ...(options || {}),
        readonly: false,
      });
    };

    // Add controls for FXAA parameters
    addControl(this.fxaaParams, 'enabled', `${componentName} Enabled`);
    addControl(this.fxaaParams, 'subPixelShift', `${componentName} Sub-pixel Shift`, {
      min: 0.0,
      max: 1.0,
      step: 0.01,
    });
    addControl(this.fxaaParams, 'edgeThreshold', `${componentName} Edge Threshold`, {
      min: 0.0,
      max: 0.5,
      step: 0.001,
    });
    addControl(this.fxaaParams, 'edgeThresholdMin', `${componentName} Edge Threshold Min`, {
      min: 0.0,
      max: 0.1,
      step: 0.001,
    });
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
