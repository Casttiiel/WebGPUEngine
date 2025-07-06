import { Component } from '../../core/ecs/Component';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { Engine } from '../../core/engine/Engine';

export class ToneMappingComponent extends Component {
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private bindGroup!: GPUBindGroup | null;
  private result!: RenderTarget;
  private renderPassManager!: RenderPassManager;

  // Tone mapping parameters that can be tweaked
  private toneMappingParams = {
    enabled: true,
    exposure: 1.0,
    gamma: 2.2,
    contrast: 1.0,
    brightness: 0.0,
    saturation: 1.0,
    toneMappingOperator: 'aces', // 'aces', 'reinhard', 'filmic', 'linear'
  };

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }
  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.technique = await Technique.get('tone_mapping.tech');

    const qualitySettings = QualitySettings.getInstance();
    const toneMappingFormat = qualitySettings.getPostProcessingFormats().toneMappingTexture;

    this.result = new RenderTarget();
    this.result.createRT('tone_mapping_result.dds', Render.width, Render.height, toneMappingFormat);
  }

  public resize(): void {
    const qualitySettings = QualitySettings.getInstance();
    const toneMappingFormat = qualitySettings.getPostProcessingFormats().toneMappingTexture;

    this.result.createRT('tone_mapping_result.dds', Render.width, Render.height, toneMappingFormat);
    this.bindGroup = null;
  }

  public apply(texture: GPUTextureView): GPUTextureView {
    this.setBindGroup(texture);

    // Use RenderPassManager to execute tone mapping pass dynamically
    this.renderPassManager.executeToneMappingPass(
      this.fullscreenQuadMesh,
      this.technique,
      this.bindGroup!,
      this.result,
    );

    return this.result.getView();
  }
  private setBindGroup(texture: GPUTextureView): void {
    if (this.bindGroup) return;

    const sampler = GPUUtils.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.bindGroup = BindGroupFactory.createBindGroup(
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
  }
  public update(_dt: number): void {
    throw new Error('Method not implemented.');
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const parentFolder = 'render';
    const subfolderKey = 'Camera Components';
    const componentName = 'Tone Mapping';

    // Add controls to the Camera Components subfolder
    const addControl = (object: unknown, propertyKey: string, label: string, options?: any) => {
      debugUI.addControlToSubFolder(parentFolder, subfolderKey, object, propertyKey, label, {
        ...(options || {}),
        readonly: false,
      });
    };

    // Add controls for tone mapping parameters
    addControl(this.toneMappingParams, 'enabled', `${componentName} Enabled`);
    addControl(this.toneMappingParams, 'exposure', `${componentName} Exposure`, {
      min: 0.1,
      max: 10.0,
      step: 0.1,
    });
    addControl(this.toneMappingParams, 'gamma', `${componentName} Gamma`, {
      min: 1.0,
      max: 3.0,
      step: 0.1,
    });
    addControl(this.toneMappingParams, 'contrast', `${componentName} Contrast`, {
      min: 0.5,
      max: 2.0,
      step: 0.05,
    });
    addControl(this.toneMappingParams, 'brightness', `${componentName} Brightness`, {
      min: -1.0,
      max: 1.0,
      step: 0.05,
    });
    addControl(this.toneMappingParams, 'saturation', `${componentName} Saturation`, {
      min: 0.0,
      max: 2.0,
      step: 0.05,
    });
  }

  public debugInMenu(): void {
    // Implement debug menu if needed
  }

  public renderDebug(): void {
    // Implement debug rendering if needed
  }
}
