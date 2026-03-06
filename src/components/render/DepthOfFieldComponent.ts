import { QualitySettings } from '../../core/engine/QualitySettings';
import { Engine } from '../../core/engine/Engine';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { PipelineFactory } from '../../renderer/core/factories/PipelineFactory';
import { DOFRenderPass } from '../../renderer/core/passes/PostProcessingRenderPasses';
import { RenderPassFactory } from '../../renderer/core/passes/RenderPassFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { Render } from '../../renderer/core/pipeline/Render';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { Component } from '../../core/ecs/Component';
import { Entity } from '../../core/ecs/Entity';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { CameraComponent } from './CameraComponent';
import { TransformComponent } from '../core/TransformComponent';
import { vec3 } from 'gl-matrix';

/**
 * Near-Far Depth of Field Component
 *
 * Implements professional-quality depth of field using 4-pass pipeline:
 * 1. CoC Calculation: Computes Circle of Confusion using physical lens equation
 * 2. Near Blur: Blurs foreground (CoC < 0) with Poisson disk sampling
 * 3. Far Blur: Blurs background (CoC > 0) with Poisson disk sampling
 * 4. Composite: Blends original + nearBlur + farBlur based on CoC
 *
 * Physical lens parameters:
 * - focus_distance: Distance to focus plane (meters)
 * - aperture: Lens aperture (f-number, e.g., 2.8 for f/2.8)
 * - focal_length: Lens focal length (meters, e.g., 0.05 for 50mm)
 * - sensor_height: Camera sensor height (meters, e.g., 0.024 for 24mm full-frame)
 */
export class DepthOfFieldComponent extends Component {
  // Techniques for 4-pass pipeline
  private cocTechnique!: Technique; // Pass 1: CoC calculation
  private nearBlurTechnique!: Technique; // Pass 2: Near blur
  private farBlurTechnique!: Technique; // Pass 3: Far blur
  private compositeTechnique!: Technique; // Pass 4: Composite

  // Render targets for intermediate results
  private cocBuffer!: RenderTarget; // Circle of Confusion (R=far, G=near, B=signed)
  private nearBlurBuffer!: RenderTarget; // Blurred foreground
  private farBlurBuffer!: RenderTarget; // Blurred background
  private finalResult!: RenderTarget; // Final composite output

  // Resources
  private fullscreenQuadMesh!: Mesh;
  private renderPassManager!: RenderPassManager;

  // Physical lens parameters (uniform buffer: 4 floats = 16 bytes)
  private dofParamsBuffer!: GPUBuffer;
  private _focusDistance: number = 10.0; // meters
  private _aperture: number = 16.0; // f-number (f/2.8)
  private _focalLength: number = 0.05; // meters (50mm)
  private _sensorHeight: number = 0.024; // meters (24mm full-frame)

  // Bind groups
  private cocBindGroup!: GPUBindGroup | null;
  private nearBlurBindGroup!: GPUBindGroup | null;
  private farBlurBindGroup!: GPUBindGroup | null;
  private compositeBindGroup!: GPUBindGroup | null;

  // ---- Adaptive auto-focus -----------------------------------------------

  /**
   * 'none'          — manual (user sets focusDistance)
   * 'screen-center' — GPU reads center pixel depth → smooth lerp
   * 'target'        — follows an Entity's world distance from camera → smooth lerp
   */
  public autoFocusMode: 'none' | 'screen-center' | 'target' = 'screen-center';

  /** Entity to follow when autoFocusMode === 'target'. */
  public focusTarget: Entity | null = null;

  /** Exponential lerp speed (units/s). Higher = reaches target faster. */
  public focusSpeed: number = 3.0;

  /** Target depth (metres) the lerp is heading toward. */
  private _targetFocusDepth: number = 10.0;

  // GPU pipeline for sampling the center pixel (screen-center mode).
  private autoFocusPipeline: GPUComputePipeline | null = null;
  private autoFocusLayout: GPUBindGroupLayout | null = null;
  private autoFocusBindGroup: GPUBindGroup | null = null;

  /** 1-float STORAGE | COPY_SRC written by the compute shader. */
  private depthResultBuffer: GPUBuffer | null = null;
  /** 1-float MAP_READ  | COPY_DST staging buffer for async readback. */
  private depthStagingBuffer: GPUBuffer | null = null;

  /**
   * 3-state readback machine (same pattern as HZBCullingPass counter):
   *  IDLE → record copy (afCopyScheduled=T)
   *  COPY_SCHEDULED → next dispatch start: call mapAsync (afMapPending=T)
   *  MAP_PENDING → promise resolves: afStagingMapped=T
   *  STAGED → next dispatch start: read + unmap → IDLE
   */
  private afCopyScheduled = false;
  private afMapPending = false;
  private afStagingMapped = false;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public async load(): Promise<void> {
    // Load all 4 techniques
    this.cocTechnique = await Technique.getAsync('post-processing/dof_coc.tech');
    this.nearBlurTechnique = await Technique.getAsync('post-processing/dof_near_blur.tech');
    this.farBlurTechnique = await Technique.getAsync('post-processing/dof_far_blur.tech');
    this.compositeTechnique = await Technique.getAsync('post-processing/dof.tech');

    // Load fullscreen quad mesh
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    // Get texture format from quality settings
    const qualitySettings = QualitySettings.getInstance();
    const hdrTexture = qualitySettings.getSettings().hdrTexture;

    // Create intermediate render targets
    this.cocBuffer = new RenderTarget();
    this.cocBuffer.createRT('dof_coc.dds', Render.width, Render.height, hdrTexture, false);

    this.nearBlurBuffer = new RenderTarget();
    this.nearBlurBuffer.createRT(
      'dof_near_blur.dds',
      Render.width,
      Render.height,
      hdrTexture,
      false,
    );

    this.farBlurBuffer = new RenderTarget();
    this.farBlurBuffer.createRT('dof_far_blur.dds', Render.width, Render.height, hdrTexture, false);

    this.finalResult = new RenderTarget();
    this.finalResult.createRT('dof_final.dds', Render.width, Render.height, hdrTexture, false);

    // Create uniform buffer for physical lens parameters
    this.dofParamsBuffer = GPUUtils.createBuffer(
      'dof_params_buffer',
      16, // 4 floats * 4 bytes = 16 bytes
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Initialize parameters
    this.updateDOFParams();

    // Initialize auto-focus GPU pipeline (screen-center mode).
    await this.initializeAutoFocus();
  }

  /**
   * Loads the auto-focus compute shader and creates its pipeline + buffers.
   * Safe to call even if the shader is unavailable — auto-focus simply stays
   * disabled (autoFocusPipeline will be null).
   */
  private async initializeAutoFocus(): Promise<void> {
    const device = GPUUtils.getDevice();
    let shaderCode: string;
    try {
      shaderCode = await ResourceManager.loadShader('utility/auto_focus_sample.cs');
    } catch {
      console.warn(
        'DepthOfFieldComponent: auto_focus_sample.cs not found — screen-center auto-focus disabled.',
      );
      return;
    }

    // Bind group layout:
    //   binding 0 — texture_2d<f32>  (gLinearDepth, unfilterable-float for textureLoad)
    //   binding 1 — storage-rw f32   (result depth)
    this.autoFocusLayout = BindGroupFactory.getLayout('af_sample_layout', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'storage' },
      },
    ]);

    const module = device.createShaderModule({
      label: 'auto_focus_sample_shader',
      code: shaderCode,
    });

    const pipelineLayout = PipelineFactory.createPipelineLayout('af_sample_pipeline_layout', [
      this.autoFocusLayout,
    ]);

    this.autoFocusPipeline = PipelineFactory.createComputePipeline({
      label: 'auto_focus_sample_pipeline',
      layout: pipelineLayout,
      compute: { module, entryPoint: 'main' },
    });

    // 1-float result buffer (shader writes here).
    this.depthResultBuffer = device.createBuffer({
      label: 'af_depth_result',
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    // Staging buffer for async CPU readback.
    this.depthStagingBuffer = device.createBuffer({
      label: 'af_depth_staging',
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }

  public resize(): void {
    const qualitySettings = QualitySettings.getInstance();
    const hdrTexture = qualitySettings.getSettings().hdrTexture;

    // Recreate all render targets with new resolution
    this.cocBuffer.createRT('dof_coc.dds', Render.width, Render.height, 'rgba16float', false);
    this.nearBlurBuffer.createRT(
      'dof_near_blur.dds',
      Render.width,
      Render.height,
      hdrTexture,
      false,
    );
    this.farBlurBuffer.createRT('dof_far_blur.dds', Render.width, Render.height, hdrTexture, false);
    this.finalResult.createRT('dof_final.dds', Render.width, Render.height, hdrTexture, false);

    // Invalidate bind groups (will be recreated on next apply)
    this.cocBindGroup = null;
    this.nearBlurBindGroup = null;
    this.farBlurBindGroup = null;
    this.compositeBindGroup = null;
    this.autoFocusBindGroup = null; // linear-depth view changed
  }

  /**
   * Update physical lens parameters in GPU buffer
   */
  private updateDOFParams(): void {
    const paramsData = new Float32Array([
      this._focusDistance, // focus_distance
      this._aperture, // aperture (f-number)
      this._focalLength, // focal_length (meters)
      this._sensorHeight, // sensor_height (meters)
    ]);

    GPUUtils.writeBuffer(this.dofParamsBuffer, 0, paramsData);
  }

  /**
   * Apply 4-pass Near-Far DOF pipeline.
   *
   * @param inputTexture       Original HDR scene texture
   * @param gBufferBindGroup   G-Buffer bind group (albedo, normals, linearDepth)
   * @param linearDepthView    Raw G-Buffer linearDepth texture view — required for
   *                           screen-center auto-focus; ignored in other modes.
   * @returns Final DOF composite texture
   */
  public apply(
    inputTexture: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
    linearDepthView?: GPUTextureView,
  ): GPUTextureView {
    // ---- Auto-focus readback state machine (must run before any encoder work) ----
    if (this.autoFocusMode === 'screen-center' && this.autoFocusPipeline) {
      // Phase COPY_SCHEDULED → MAP_PENDING
      if (this.afCopyScheduled && !this.afMapPending && !this.afStagingMapped) {
        this.afCopyScheduled = false;
        this.afMapPending = true;
        this.depthStagingBuffer!.mapAsync(GPUMapMode.READ)
          .then(() => {
            this.afMapPending = false;
            this.afStagingMapped = true;
          })
          .catch(() => {
            this.afMapPending = false; // device lost / buffer destroyed — reset to IDLE
          });
      }

      // Phase STAGED → IDLE: read the value and convert to metres
      if (this.afStagingMapped) {
        const raw = new Float32Array(this.depthStagingBuffer!.getMappedRange())[0]!;
        this.depthStagingBuffer!.unmap();
        this.afStagingMapped = false;

        // raw is linear depth [0, 1].  Skip sky (≥0.9999) and clip near (≤0.001).
        if (raw > 0.001 && raw < 0.9999) {
          try {
            const cam = (this.getOwner().getComponent('camera') as CameraComponent).getCamera();
            this._targetFocusDepth = raw * cam.getFar();
          } catch {
            /* owner not yet set — ignore */
          }
        }
      }
    }
    // Pass 1: Calculate Circle of Confusion
    this.renderCoCPass(gBufferBindGroup);

    // Pass 2: Near blur (foreground)
    this.renderNearBlurPass(inputTexture, gBufferBindGroup);

    // Pass 3: Far blur (background)
    this.renderFarBlurPass(inputTexture, gBufferBindGroup);

    // Pass 4: Composite all layers
    this.renderCompositePass(inputTexture, gBufferBindGroup);

    // ---- Screen-center auto-focus: dispatch sample compute + schedule readback ----
    if (
      this.autoFocusMode === 'screen-center' &&
      this.autoFocusPipeline &&
      this.autoFocusLayout &&
      linearDepthView &&
      !this.afCopyScheduled &&
      !this.afMapPending &&
      !this.afStagingMapped
    ) {
      // (Re-)create bind group lazily — invalidated by resize() via invalidateBindGroups()
      if (!this.autoFocusBindGroup) {
        this.autoFocusBindGroup = BindGroupFactory.createBindGroup(
          'af_sample_bind_group',
          this.autoFocusLayout,
          [
            { binding: 0, resource: linearDepthView },
            { binding: 1, resource: { buffer: this.depthResultBuffer! } },
          ],
        );
      }

      const encoder = Render.getInstance().getCommandEncoder();
      const pass = encoder.beginComputePass({ label: 'auto_focus_sample' });
      pass.setPipeline(this.autoFocusPipeline);
      pass.setBindGroup(0, this.autoFocusBindGroup);
      pass.dispatchWorkgroups(1, 1, 1);
      pass.end();

      // Schedule readback — mapAsync is called NEXT frame to avoid
      // "used in submit while pending map" (same technique as HZBCullingPass).
      encoder.copyBufferToBuffer(this.depthResultBuffer!, 0, this.depthStagingBuffer!, 0, 4);
      this.afCopyScheduled = true;
    }

    return this.finalResult.getRenderView()!;
  }

  /**
   * Pass 1: Circle of Confusion Calculation
   * Uses physical lens equation to compute CoC for each pixel
   * Output: R=farCoC, G=nearCoC, B=signedCoC, A=unused
   */
  private renderCoCPass(gBufferBindGroup: GPUBindGroup): void {
    // Create bind group for CoC pass (only if not cached)
    if (!this.cocBindGroup) {
      this.cocBindGroup = BindGroupFactory.createBindGroup(
        'dof_coc_params',
        this.cocTechnique.getPipeline().getBindGroupLayout(2),
        [
          {
            binding: 0,
            resource: {
              buffer: this.dofParamsBuffer,
            },
          },
        ],
      );
    }

    // Execute CoC pass
    const passConfig = RenderPassFactory.createDOFPassConfig(this.cocBuffer.getRenderView()!);
    const pass = new DOFRenderPass(
      passConfig,
      this.fullscreenQuadMesh,
      this.cocTechnique,
      this.cocBindGroup,
      gBufferBindGroup,
    );

    this.renderPassManager.executeDynamicPass(pass);
  }

  /**
   * Pass 2: Near Blur (Foreground)
   * Applies Poisson disk blur to foreground objects (nearCoC > 0.5)
   */
  private renderNearBlurPass(inputTexture: GPUTextureView, gBufferBindGroup: GPUBindGroup): void {
    // Create bind group for near blur pass
    if (!this.nearBlurBindGroup) {
      this.nearBlurBindGroup = BindGroupFactory.createBindGroup(
        'dof_near_blur_textures',
        this.nearBlurTechnique.getPipeline().getBindGroupLayout(2),
        [
          {
            binding: 0,
            resource: inputTexture, // Original scene texture
          },
          {
            binding: 1,
            resource: this.cocBuffer.getView(), // CoC texture
          },
          {
            binding: 2,
            resource: SamplerLibrary.simpleSampler, // Linear sampler
          },
        ],
      );
    }

    // Execute near blur pass (camera at group 0, textures at group 1)
    const passConfig = RenderPassFactory.createDOFPassConfig(this.nearBlurBuffer.getRenderView()!);
    const pass = new DOFRenderPass(
      passConfig,
      this.fullscreenQuadMesh,
      this.nearBlurTechnique,
      this.nearBlurBindGroup,
      gBufferBindGroup,
    );

    this.renderPassManager.executeDynamicPass(pass);
  }

  /**
   * Pass 3: Far Blur (Background)
   * Applies Poisson disk blur to background objects (farCoC > 0.5)
   */
  private renderFarBlurPass(inputTexture: GPUTextureView, gBufferBindGroup: GPUBindGroup): void {
    // Create bind group for far blur pass
    if (!this.farBlurBindGroup) {
      this.farBlurBindGroup = BindGroupFactory.createBindGroup(
        'dof_far_blur_textures',
        this.farBlurTechnique.getPipeline().getBindGroupLayout(2),
        [
          {
            binding: 0,
            resource: inputTexture, // Original scene texture
          },
          {
            binding: 1,
            resource: this.cocBuffer.getView(), // CoC texture
          },
          {
            binding: 2,
            resource: SamplerLibrary.simpleSampler, // Linear sampler
          },
        ],
      );
    }

    // Execute far blur pass (camera at group 0, textures at group 1)
    const passConfig = RenderPassFactory.createDOFPassConfig(this.farBlurBuffer.getRenderView()!);
    const pass = new DOFRenderPass(
      passConfig,
      this.fullscreenQuadMesh,
      this.farBlurTechnique,
      this.farBlurBindGroup,
      gBufferBindGroup,
    );

    this.renderPassManager.executeDynamicPass(pass);
  }

  /**
   * Pass 4: Composite
   * Blends original + nearBlur + farBlur based on CoC values
   */
  private renderCompositePass(inputTexture: GPUTextureView, gBufferBindGroup: GPUBindGroup): void {
    // Create bind group for composite pass
    if (!this.compositeBindGroup) {
      this.compositeBindGroup = BindGroupFactory.createBindGroup(
        'dof_composite_textures',
        this.compositeTechnique.getPipeline().getBindGroupLayout(2),
        [
          {
            binding: 0,
            resource: inputTexture, // Original scene
          },
          {
            binding: 1,
            resource: this.nearBlurBuffer.getView(), // Near blur result
          },
          {
            binding: 2,
            resource: this.farBlurBuffer.getView(), // Far blur result
          },
          {
            binding: 3,
            resource: this.cocBuffer.getView(), // CoC texture
          },
          {
            binding: 4,
            resource: SamplerLibrary.simpleSampler, // Linear sampler
          },
        ],
      );
    }

    // Execute composite pass
    const passConfig = RenderPassFactory.createDOFPassConfig(this.finalResult.getRenderView()!);
    const pass = new DOFRenderPass(
      passConfig,
      this.fullscreenQuadMesh,
      this.compositeTechnique,
      this.compositeBindGroup,
      gBufferBindGroup,
    );

    this.renderPassManager.executeDynamicPass(pass);
  }

  /**
   * Set focus distance (distance to focus plane in meters)
   */
  public set focusDistance(value: number) {
    this._focusDistance = Math.max(0.1, value);
    this.updateDOFParams();
    this.invalidateBindGroups();
  }

  public get focusDistance(): number {
    return this._focusDistance;
  }

  /**
   * Set aperture (f-number, e.g., 2.8 for f/2.8)
   * Lower values = more blur, higher values = less blur
   */
  public set aperture(value: number) {
    this._aperture = Math.max(1.0, value);
    this.updateDOFParams();
    this.invalidateBindGroups();
  }

  public get aperture(): number {
    return this._aperture;
  }

  /**
   * Set focal length in meters (e.g., 0.05 for 50mm lens)
   */
  public set focalLength(value: number) {
    this._focalLength = Math.max(0.01, value);
    this.updateDOFParams();
    this.invalidateBindGroups();
  }

  public get focalLength(): number {
    return this._focalLength;
  }

  /**
   * Set sensor height in meters (e.g., 0.024 for 24mm full-frame)
   */
  public set sensorHeight(value: number) {
    this._sensorHeight = Math.max(0.001, value);
    this.updateDOFParams();
    this.invalidateBindGroups();
  }

  public get sensorHeight(): number {
    return this._sensorHeight;
  }

  /**
   * Invalidate all cached bind groups
   */
  private invalidateBindGroups(): void {
    this.cocBindGroup = null;
    this.nearBlurBindGroup = null;
    this.farBlurBindGroup = null;
    this.compositeBindGroup = null;
    this.autoFocusBindGroup = null; // will be rebuilt with updated views
  }

  public hasLoaded(): boolean {
    return (
      this.cocTechnique !== undefined &&
      this.nearBlurTechnique !== undefined &&
      this.farBlurTechnique !== undefined &&
      this.compositeTechnique !== undefined &&
      this.fullscreenQuadMesh !== undefined &&
      this.cocBuffer !== undefined &&
      this.nearBlurBuffer !== undefined &&
      this.farBlurBuffer !== undefined &&
      this.finalResult !== undefined
    );
  }

  public update(dt: number): void {
    if (this.autoFocusMode === 'none') return;

    // In 'target' mode, compute world-space distance from camera to entity directly.
    if (this.autoFocusMode === 'target' && this.focusTarget) {
      try {
        const cam = (this.getOwner().getComponent('camera') as CameraComponent).getCamera();
        const cameraPos = cam.getPosition();
        const transform = this.focusTarget.getComponent('transform') as TransformComponent | null;
        if (transform) {
          const targetPos = transform.getTransform().getWorldPosition();
          this._targetFocusDepth = Math.max(0.1, vec3.distance(cameraPos, targetPos));
        }
      } catch {
        /* owner not ready */
      }
    }

    // Exponential lerp: feels organic and is frame-rate independent.
    //   alpha = 1 − e^(−speed × dt)  →  at speed=3, reaches 95% in ~1 s.
    const alpha = 1.0 - Math.exp(-this.focusSpeed * dt);
    const newFocus = this._focusDistance + (this._targetFocusDepth - this._focusDistance) * alpha;

    if (Math.abs(newFocus - this._focusDistance) > 0.0001) {
      this._focusDistance = Math.max(0.1, newFocus);
      this.updateDOFParams();
    }
  }

  public override renderInMenu(): void {}

  public override renderDebug(): void {
    // Implement debug visualization if needed
  }

  public dispose(): void {
    // Clean up DoF render targets
    if (this.cocBuffer) this.cocBuffer.destroy();
    if (this.nearBlurBuffer) this.nearBlurBuffer.destroy();
    if (this.farBlurBuffer) this.farBlurBuffer.destroy();
    if (this.finalResult) this.finalResult.destroy();
    if (this.dofParamsBuffer) this.dofParamsBuffer.destroy();

    // Clean up auto-focus GPU resources
    this.depthResultBuffer?.destroy();
    this.depthStagingBuffer?.destroy();
    this.depthResultBuffer = null;
    this.depthStagingBuffer = null;
    // Reset readback state so nothing tries to unmap a destroyed buffer.
    this.afCopyScheduled = false;
    this.afMapPending = false;
    this.afStagingMapped = false;
  }
}
