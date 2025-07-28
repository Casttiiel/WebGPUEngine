import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { Render } from '../../renderer/core/pipeline/Render';

export class AmbientOcclusionComponent extends Component {
  private aoTechnique!: Technique;
  private bilateralFilterTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private renderPassManager!: RenderPassManager;

  // Render targets for the two-pass process
  private rawAOTarget!: RenderTarget;
  private bilateralFilterBindGroup!: GPUBindGroup | null;

  // Dynamic SSAO Parameters from quality settings
  private ssaoParams = {
    sampleCount: 64 as number, // Será convertido a u32 al escribir en el buffer
    radius: 0.5,
    bias: 0.025,
    aoStrength: 1.5,
    maxDistance: 1.0,
    occScale: 4.0,
  };

  // Cache previous values to detect changes (initialized in constructor)
  private previousSSAOParams!: typeof this.ssaoParams;

  // Uniform buffer for SSAO parameters
  private ssaoParamsBuffer!: GPUBuffer;
  private ssaoParamsBindGroup!: GPUBindGroup | null;
  private debugControlsAdded = false;
  private isEnabled = true;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
    // Initialize previous params after ssaoParams is defined
    this.previousSSAOParams = { ...this.ssaoParams };

    // Update parameters from quality settings
    this.updateParametersFromQuality();
  }

  private updateParametersFromQuality(): void {
    const qualitySettings = QualitySettings.getInstance();
    const aoConfig = qualitySettings.getAmbientOcclusionConfig();

    this.isEnabled = aoConfig.enabled;

    if (aoConfig.enabled) {
      this.ssaoParams = {
        sampleCount: aoConfig.sampleCount,
        radius: aoConfig.radius,
        bias: aoConfig.bias,
        aoStrength: aoConfig.aoStrength,
        maxDistance: aoConfig.maxDistance,
        occScale: aoConfig.noiseScale,
      };
    }
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.aoTechnique = await Technique.get('ambient_occlusion.tech');
    this.bilateralFilterTechnique = await Technique.get('ao_bilateral_filter.tech');

    // Create intermediate render target for raw AO
    const qualitySettings = QualitySettings.getInstance();
    const aoFormat = qualitySettings.getPostProcessingFormats().aoTexture;

    this.rawAOTarget = new RenderTarget();
    this.rawAOTarget.createRT('raw_ao_result.dds', Render.width, Render.height, aoFormat);

    // Create uniform buffer for SSAO parameters
    this.createSSAOParamsBuffer();
  }

  private createSSAOParamsBuffer(): void {
    // Create buffer with enough space for SSAO parameters only
    // 6 floats + padding = 32 bytes (aligned to 16 bytes)
    this.ssaoParamsBuffer = GPUUtils.createBuffer(
      'SSAO Parameters Buffer',
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.updateSSAOParamsBuffer();
  }

  private updateSSAOParamsBuffer(): void {
    // Creamos un ArrayBuffer para almacenar tanto u32 como f32
    const arrayBuffer = new ArrayBuffer(32); // 8 * 4 bytes (1 u32 + 5 f32 + 2 padding)
    const u32View = new Uint32Array(arrayBuffer, 0, 1);
    const f32View = new Float32Array(arrayBuffer, 4); // Comienza después del u32

    // Escribimos los datos
    u32View[0] = this.ssaoParams.sampleCount;
    f32View[0] = this.ssaoParams.radius;
    f32View[1] = this.ssaoParams.bias;
    f32View[2] = this.ssaoParams.aoStrength;
    f32View[3] = this.ssaoParams.maxDistance;
    f32View[4] = this.ssaoParams.occScale;
    f32View[5] = 0; // padding
    f32View[6] = 0; // padding

    const paramsData = new Uint8Array(arrayBuffer);

    GPUUtils.writeBuffer(this.ssaoParamsBuffer, 0, paramsData);

    // Update the previous params cache
    this.previousSSAOParams = { ...this.ssaoParams };
  }

  private hasParametersChanged(): boolean {
    return (
      this.ssaoParams.sampleCount !== this.previousSSAOParams.sampleCount ||
      this.ssaoParams.radius !== this.previousSSAOParams.radius ||
      this.ssaoParams.bias !== this.previousSSAOParams.bias ||
      this.ssaoParams.aoStrength !== this.previousSSAOParams.aoStrength ||
      this.ssaoParams.maxDistance !== this.previousSSAOParams.maxDistance ||
      this.ssaoParams.occScale !== this.previousSSAOParams.occScale
    );
  }

  public resize(): void {
    // Update parameters from quality settings in case they changed
    this.updateParametersFromQuality();

    const qualitySettings = QualitySettings.getInstance();
    const aoFormat = qualitySettings.getPostProcessingFormats().aoTexture;

    this.rawAOTarget.createRT('raw_ao_result.dds', Render.width, Render.height, aoFormat);
    this.bilateralFilterBindGroup = null;
    this.ssaoParamsBindGroup = null;

    // Force update of SSAO parameters buffer
    if (this.ssaoParamsBuffer) {
      this.updateSSAOParamsBuffer();
    }
  }

  private createSSAOParamsBindGroup(): void {
    if (this.ssaoParamsBindGroup) return;

    this.ssaoParamsBindGroup = BindGroupFactory.createBindGroup(
      'ssao_params_bindgroup',
      BindGroupFactory.getBufferUniformLayout(),
      [
        {
          binding: 0,
          resource: {
            buffer: this.ssaoParamsBuffer,
          },
        },
      ],
    );
  }

  private renderDisabledAO(finalAOTarget: RenderTarget): void {
    // When AO is disabled, we need to fill the target with white (no occlusion)
    // This ensures the lighting calculations work correctly
    const commandEncoder = GPUUtils.getDevice().createCommandEncoder({
      label: 'Disabled AO Clear Pass',
    });

    const renderPass = commandEncoder.beginRenderPass({
      label: 'Clear AO Target',
      colorAttachments: [
        {
          view: finalAOTarget.getView(),
          clearValue: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }, // White = no occlusion
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    renderPass.end();
    GPUUtils.getDevice().queue.submit([commandEncoder.finish()]);
  }

  public compute(gBufferBindGroup: GPUBindGroup, finalAOTarget: RenderTarget): void {
    // Update parameters from quality settings (in case they changed)
    this.updateParametersFromQuality();

    // Update SSAO parameters buffer if parameters changed
    if (this.hasParametersChanged()) {
      this.updateSSAOParamsBuffer();
      // Invalidate bind group to recreate with new parameters
      this.ssaoParamsBindGroup = null;
    }

    // If AO is disabled, render a white texture (no occlusion)
    if (!this.isEnabled) {
      this.renderDisabledAO(finalAOTarget);
      return;
    }

    this.createSSAOParamsBindGroup();

    // Pass 1: Generate raw AO using SSAO with parameters
    this.renderPassManager.executeAmbientOcclusionPass(
      this.fullscreenQuadMesh,
      this.aoTechnique,
      gBufferBindGroup,
      this.ssaoParamsBindGroup!,
      this.rawAOTarget,
    );

    // Pass 2: Apply bilateral filter to the raw AO
    this.applyBilateralFilter(gBufferBindGroup, finalAOTarget);
  }

  private applyBilateralFilter(gBufferBindGroup: GPUBindGroup, finalAOTarget: RenderTarget): void {
    this.setupBilateralFilterBindGroup();

    // Use RenderPassManager to execute bilateral filter pass with both bind groups
    this.renderPassManager.executeAOBilateralFilterPass(
      this.fullscreenQuadMesh,
      this.bilateralFilterTechnique,
      gBufferBindGroup, // G-Buffer bind group (group 1)
      this.bilateralFilterBindGroup!, // AO texture bind group (group 2)
      finalAOTarget,
    );
  }

  private setupBilateralFilterBindGroup(): void {
    if (this.bilateralFilterBindGroup) return;

    const sampler = GPUUtils.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // Create bind group for AO texture (group 2 in the shader) using SingleTexture layout
    this.bilateralFilterBindGroup = BindGroupFactory.createBindGroup(
      `ao_bilateral_filter_bindgroup`,
      BindGroupFactory.getSingleTextureLayout(),
      [
        {
          binding: 0,
          resource: this.rawAOTarget.getView(),
        },
        {
          binding: 1,
          resource: sampler,
        },
      ],
    );
  }

  public update(_dt: number): void {
    // Only update SSAO parameters buffer if any parameter changed
    if (this.hasSSAOParametersChanged()) {
      this.updateSSAOParamsBuffer();
      this.previousSSAOParams = { ...this.ssaoParams };
      // Force recreate bind group on next use to pick up new buffer data
      this.ssaoParamsBindGroup = null;
    }
  }

  private hasSSAOParametersChanged(): boolean {
    return (
      this.ssaoParams.sampleCount !== this.previousSSAOParams.sampleCount ||
      this.ssaoParams.radius !== this.previousSSAOParams.radius ||
      this.ssaoParams.bias !== this.previousSSAOParams.bias ||
      this.ssaoParams.aoStrength !== this.previousSSAOParams.aoStrength ||
      this.ssaoParams.maxDistance !== this.previousSSAOParams.maxDistance ||
      this.ssaoParams.occScale !== this.previousSSAOParams.occScale
    );
  }

  public override renderInMenu(): void {
    if (this.debugControlsAdded) return;

    const debugUI = Engine.getDebugUI();
    const parentFolder = 'render';
    const subfolderKey = 'Camera Components';
    const componentName = 'Ambient Occlusion';

    // Add controls to the Camera Components subfolder
    const addControl = (object: unknown, propertyKey: string, label: string, options?: any) => {
      debugUI.addControlToSubFolder(parentFolder, subfolderKey, object, propertyKey, label, {
        ...(options || {}),
        readonly: false,
      });
    };

    // Enable/Disable control
    addControl(this, 'isEnabled', `${componentName} Enabled`);

    // SSAO Parameters with appropriate ranges
    addControl(this.ssaoParams, 'sampleCount', `${componentName} Sample Count`, {
      min: 4,
      max: 32,
      step: 1,
    });
    addControl(this.ssaoParams, 'radius', `${componentName} Radius`, {
      min: 0.1,
      max: 2.0,
      step: 0.01,
    });
    addControl(this.ssaoParams, 'bias', `${componentName} Bias`, {
      min: 0.001,
      max: 0.1,
      step: 0.001,
    });
    addControl(this.ssaoParams, 'aoStrength', `${componentName} Strength`, {
      min: 0.1,
      max: 5.0,
      step: 0.1,
    });
    addControl(this.ssaoParams, 'maxDistance', `${componentName} Max Distance`, {
      min: 0.1,
      max: 5.0,
      step: 0.1,
    });
    addControl(this.ssaoParams, 'occScale', `${componentName} Noise Scale`, {
      min: 1.0,
      max: 10.0,
      step: 0.1,
    });

    this.debugControlsAdded = true;
  }

  public renderDebug(): void {
    // Implement debug rendering if needed
  }

  protected addInteractiveControl(
    object: unknown,
    propertyKey: string,
    label?: string,
    options?: { min?: number; max?: number; step?: number },
  ): void {
    const debugUI = Engine.getDebugUI();
    debugUI.addInteractiveControl('SSAO', object, propertyKey, label, options);
  }

  protected addDebugControl(object: unknown, propertyKey: string, label?: string): void {
    const debugUI = Engine.getDebugUI();
    debugUI.addDebugControl('SSAO', object, propertyKey, label);
  }
}
