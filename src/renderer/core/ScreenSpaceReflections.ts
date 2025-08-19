import { Technique } from '../resources/Technique';
import { RenderTarget } from '../resources/RenderTarget';
import { Mesh } from '../resources/Mesh';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { Render } from '../core/pipeline/Render';
import { Engine } from '../../core/engine/Engine';

export class ScreenSpaceReflections {
  // SSR Parameters
  private intensity: number = 1.0;
  private stepSize: number = 0.1;
  private maxSteps: number = 50;
  private maxDistance: number = 50.0;
  private thickness: number = 0.5;
  private enabled: boolean = true;

  // GPU Resources
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private uniformBuffer!: GPUBuffer;
  private ssrBindGroup!: GPUBindGroup;
  private gBufferBindGroup!: GPUBindGroup;

  // Render Targets
  private ssrResult!: RenderTarget;
  private reflectionMask!: RenderTarget;

  // Initialization flag
  private isInitialized: boolean = false;

  constructor() {
    // Constructor vacío, inicialización en load()
  }

  public async load(): Promise<void> {
    try {
      // Initialize GPU resources
      await this.initializeResources();
      this.createRenderTargets();
      this.createUniformBuffer();
      this.createBindGroups();

      this.isInitialized = true;

      // Add debug controls
      this.setupDebugControls();

      console.log('SSR loaded successfully');
    } catch (error) {
      console.warn('Failed to load SSR, disabling feature:', error);
      this.enabled = false;
      this.isInitialized = false;
    }
  }

  private async initializeResources(): Promise<void> {
    this.technique = await Technique.get('ssr.tech');
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
  }

  private createRenderTargets(): void {
    // SSR result texture (HDR format for reflections)
    this.ssrResult = new RenderTarget();
    this.ssrResult.createRT(
      'ssr_result',
      Render.width,
      Render.height,
      'rgba16float', // HDR format for reflections
      false, // No MSAA for post-processing
    );

    // Reflection mask (marks which pixels should have reflections)
    this.reflectionMask = new RenderTarget();
    this.reflectionMask.createRT(
      'reflection_mask',
      Render.width,
      Render.height,
      'r8unorm', // Single channel for mask
      false,
    );
  }

  public resize(): void {
    if (!this.isInitialized) return;

    // Recreate render targets with new dimensions
    this.ssrResult.createRT('ssr_result', Render.width, Render.height, 'rgba16float', false);

    this.reflectionMask.createRT('reflection_mask', Render.width, Render.height, 'r8unorm', false);

    // Recreate bind groups since render targets changed
    this.createBindGroups();
  }

  private createUniformBuffer(): void {
    // SSR parameters: intensity, stepSize, maxSteps, maxDistance, thickness, enabled
    const bufferSize = 8 * 4; // 8 floats * 4 bytes each

    this.uniformBuffer = GPUUtils.createBuffer(
      'ssr_uniforms',
      bufferSize,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.updateUniforms();
  }

  private updateUniforms(): void {
    if (!this.uniformBuffer) return;

    const uniforms = new Float32Array([
      this.intensity,
      this.stepSize,
      this.maxSteps,
      this.maxDistance,
      this.thickness,
      this.enabled ? 1.0 : 0.0,
      0.0, // padding
      0.0, // padding
    ]);

    GPUUtils.writeBuffer(this.uniformBuffer, 0, uniforms);
  }

  private createBindGroups(): void {
    // SSR parameters bind group (group 2)
    this.ssrBindGroup = BindGroupFactory.createBindGroup(
      'ssr_params_bind_group',
      this.technique.getPipeline().getBindGroupLayout(2)!,
      [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
    );
  }

  public setGBufferBindGroup(gBufferBindGroup: GPUBindGroup): void {
    this.gBufferBindGroup = gBufferBindGroup;
  }

  public apply(inputTexture: GPUTextureView, gBufferBindGroup: GPUBindGroup): GPUTextureView {
    if (!this.isInitialized || !this.enabled) {
      return inputTexture; // Return input unchanged if disabled
    }

    // Execute SSR to our own render target
    this.executeSSRPass(gBufferBindGroup);

    // Return the SSR result texture for further composition
    return this.ssrResult.getView();
  }

  private executeSSRPass(gBufferBindGroup: GPUBindGroup): void {
    // Get command encoder from the render system
    const commandEncoder = Render.getInstance().getCommandEncoder();

    // Create render pass that renders SSR to our own render target
    const renderPassDescriptor: GPURenderPassDescriptor = {
      label: 'SSR Render Pass',
      colorAttachments: [
        {
          view: this.ssrResult.getRenderView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear', // Clear since we're writing only reflections
          storeOp: 'store',
        },
      ],
    };

    const renderPass = commandEncoder.beginRenderPass(renderPassDescriptor);

    // Set pipeline and bind groups
    renderPass.setPipeline(this.technique.getPipeline());

    // Bind camera uniforms (group 0)
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    if (mainCamera?.hasComponent('camera')) {
      const cameraComponent = mainCamera.getComponent('camera') as any;
      renderPass.setBindGroup(0, cameraComponent.getCamera().getBindGroup());
    }

    // Bind G-Buffer textures with lit scene (group 1)
    renderPass.setBindGroup(1, gBufferBindGroup);

    // Bind SSR parameters (group 2)
    renderPass.setBindGroup(2, this.ssrBindGroup);

    // Render fullscreen quad to apply SSR
    this.fullscreenQuadMesh.activate(renderPass);
    this.fullscreenQuadMesh.renderGroup(renderPass);

    renderPass.end();
  }

  private setupDebugControls(): void {
    const debugUI = Engine.getDebugUI();
    const folder = 'Screen Space Reflections';

    debugUI.addInteractiveControl(folder, this, 'enabled', 'Enabled');
    debugUI.addInteractiveControl(folder, this, 'intensity', 'Intensity', {
      min: 0,
      max: 2,
      step: 0.1,
    });
    debugUI.addInteractiveControl(folder, this, 'stepSize', 'Step Size', {
      min: 0.01,
      max: 1.0,
      step: 0.01,
    });
    debugUI.addInteractiveControl(folder, this, 'maxSteps', 'Max Steps', {
      min: 10,
      max: 100,
      step: 1,
    });
    debugUI.addInteractiveControl(folder, this, 'maxDistance', 'Max Distance', {
      min: 1,
      max: 100,
      step: 1,
    });
    debugUI.addInteractiveControl(folder, this, 'thickness', 'Thickness', {
      min: 0.1,
      max: 2.0,
      step: 0.1,
    });
  }

  // Getters and setters for parameters
  public getIntensity(): number {
    return this.intensity;
  }
  public getStepSize(): number {
    return this.stepSize;
  }
  public getMaxSteps(): number {
    return this.maxSteps;
  }
  public getMaxDistance(): number {
    return this.maxDistance;
  }
  public getThickness(): number {
    return this.thickness;
  }
  public isEnabled(): boolean {
    return this.enabled;
  }

  public setIntensity(value: number): void {
    this.intensity = value;
    this.updateUniforms();
  }

  public setStepSize(value: number): void {
    this.stepSize = value;
    this.updateUniforms();
  }

  public setMaxSteps(value: number): void {
    this.maxSteps = value;
    this.updateUniforms();
  }

  public setMaxDistance(value: number): void {
    this.maxDistance = value;
    this.updateUniforms();
  }

  public setThickness(value: number): void {
    this.thickness = value;
    this.updateUniforms();
  }

  public setEnabled(value: boolean): void {
    this.enabled = value;
    this.updateUniforms();
  }

  public dispose(): void {
    this.uniformBuffer?.destroy();
    this.ssrResult?.destroy();
    this.reflectionMask?.destroy();
  }
}
