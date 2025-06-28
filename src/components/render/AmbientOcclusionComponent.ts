import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { Render } from '../../renderer/core/Render';
import { RenderToTexture } from '../../renderer/core/RenderToTexture';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';

export class AmbientOcclusionComponent extends Component {
  private aoTechnique!: Technique;
  private bilateralFilterTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private renderPassManager!: RenderPassManager;

  // Render targets for the two-pass process
  private rawAOTarget!: RenderToTexture;
  private bilateralFilterBindGroup!: GPUBindGroup | null;

  // SSAO Parameters for ImGui
  private ssaoParams = {
    sampleCount: 16,
    radius: 0.5,
    bias: 0.025,
    aoStrength: 1.5,
    maxDistance: 1.0,
    noiseScale: 4.0,
  };

  // Cache previous values to detect changes (initialized in constructor)
  private previousSSAOParams!: typeof this.ssaoParams;

  // Uniform buffer for SSAO parameters
  private ssaoParamsBuffer!: GPUBuffer;
  private ssaoParamsBindGroup!: GPUBindGroup | null;
  private debugControlsAdded = false;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
    // Initialize previous params after ssaoParams is defined
    this.previousSSAOParams = { ...this.ssaoParams };
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.aoTechnique = await Technique.get('ambient_occlusion.tech');
    this.bilateralFilterTechnique = await Technique.get('ao_bilateral_filter.tech');

    // Create intermediate render target for raw AO
    this.rawAOTarget = new RenderToTexture();
    this.rawAOTarget.createRT('raw_ao_result.dds', Render.width, Render.height, 'r16float');

    // Create uniform buffer for SSAO parameters
    this.createSSAOParamsBuffer();
  }

  private createSSAOParamsBuffer(): void {
    // Create buffer with enough space for SSAO parameters only
    // 6 floats + padding = 32 bytes (aligned to 16 bytes)
    this.ssaoParamsBuffer = GPUUtils.createBuffer(
      'SSAO Parameters Buffer',
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    );

    this.updateSSAOParamsBuffer();
  }

  private updateSSAOParamsBuffer(): void {
    // Pack SSAO parameters only into Float32Array
    const paramsData = new Float32Array([
      this.ssaoParams.sampleCount,
      this.ssaoParams.radius,
      this.ssaoParams.bias,
      this.ssaoParams.aoStrength,
      this.ssaoParams.maxDistance,
      this.ssaoParams.noiseScale,
      0, // padding
      0  // padding
    ]);

    GPUUtils.writeBuffer(this.ssaoParamsBuffer, 0, paramsData);
  }

  public resize(): void {
    this.rawAOTarget.createRT('raw_ao_result.dds', Render.width, Render.height, 'r16float');
    this.bilateralFilterBindGroup = null;
    this.ssaoParamsBindGroup = null;
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
      ]
    );
  }

  public compute(gBufferBindGroup: GPUBindGroup, finalAOTarget: RenderToTexture): void {
    this.createSSAOParamsBindGroup();

    // Pass 1: Generate raw AO using SSAO with parameters
    this.renderPassManager.executeAmbientOcclusionPass(
      this.fullscreenQuadMesh,
      this.aoTechnique,
      gBufferBindGroup,
      this.ssaoParamsBindGroup!,
      this.rawAOTarget
    );

    // Pass 2: Apply bilateral filter to the raw AO
    this.applyBilateralFilter(gBufferBindGroup, finalAOTarget);
  }

  private applyBilateralFilter(gBufferBindGroup: GPUBindGroup, finalAOTarget: RenderToTexture): void {
    this.setupBilateralFilterBindGroup();

    // Use RenderPassManager to execute bilateral filter pass with both bind groups
    this.renderPassManager.executeAOBilateralFilterPass(
      this.fullscreenQuadMesh,
      this.bilateralFilterTechnique,
      gBufferBindGroup,              // G-Buffer bind group (group 1)
      this.bilateralFilterBindGroup!, // AO texture bind group (group 2)
      finalAOTarget
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
      ]
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
      this.ssaoParams.noiseScale !== this.previousSSAOParams.noiseScale
    );
  }

  public override renderInMenu(): void {
    if (this.debugControlsAdded) return;

    // SSAO Parameters with appropriate ranges
    this.addInteractiveControl(this.ssaoParams, 'sampleCount', 'SSAO Sample Count', { min: 4, max: 32, step: 1 });
    this.addInteractiveControl(this.ssaoParams, 'radius', 'SSAO Radius', { min: 0.1, max: 2.0, step: 0.01 });
    this.addInteractiveControl(this.ssaoParams, 'bias', 'SSAO Bias', { min: 0.001, max: 0.1, step: 0.001 });
    this.addInteractiveControl(this.ssaoParams, 'aoStrength', 'SSAO Strength', { min: 0.1, max: 5.0, step: 0.1 });
    this.addInteractiveControl(this.ssaoParams, 'maxDistance', 'SSAO Max Distance', { min: 0.1, max: 5.0, step: 0.1 });
    this.addInteractiveControl(this.ssaoParams, 'noiseScale', 'SSAO Noise Scale', { min: 1.0, max: 10.0, step: 0.1 });

    this.debugControlsAdded = true;
  }

  public renderDebug(): void {
    // Implement debug rendering if needed
  }

  protected addInteractiveControl(
    object: unknown, 
    propertyKey: string, 
    label?: string,
    options?: { min?: number; max?: number; step?: number }
  ): void {
    const moduleManager = Engine.getModules();
    moduleManager.addInteractiveControl('SSAO', object, propertyKey, label, options);
  }

  protected addDebugControl(object: unknown, propertyKey: string, label?: string): void {
    const moduleManager = Engine.getModules();
    moduleManager.addDebugControl('SSAO', object, propertyKey, label);
  }
}
