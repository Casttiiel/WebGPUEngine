import { QualitySettings } from '../../core/engine/QualitySettings';
import { Engine } from '../../core/engine/Engine';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { DOFRenderPass } from '../../renderer/core/passes/PostProcessingRenderPasses';
import { RenderPassFactory } from '../../renderer/core/passes/RenderPassFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { Render } from '../../renderer/core/pipeline/Render';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { Component } from '../../core/ecs/Component';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';

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
  private _aperture: number = 2.8; // f-number (f/2.8)
  private _focalLength: number = 0.05; // meters (50mm)
  private _sensorHeight: number = 0.024; // meters (24mm full-frame)

  // Bind groups
  private cocBindGroup!: GPUBindGroup | null;
  private nearBlurBindGroup!: GPUBindGroup | null;
  private farBlurBindGroup!: GPUBindGroup | null;
  private compositeBindGroup!: GPUBindGroup | null;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public async load(): Promise<void> {
    // Load all 4 techniques
    this.cocTechnique = await Technique.getAsync('dof_coc.tech');
    this.nearBlurTechnique = await Technique.getAsync('dof_near_blur.tech');
    this.farBlurTechnique = await Technique.getAsync('dof_far_blur.tech');
    this.compositeTechnique = await Technique.getAsync('dof.tech');

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
   * Apply 4-pass Near-Far DOF pipeline
   * @param inputTexture - Original HDR scene texture
   * @param gBufferBindGroup - G-Buffer bind group (albedo, normals, depth)
   * @returns Final DOF composite texture
   */
  public apply(inputTexture: GPUTextureView, gBufferBindGroup: GPUBindGroup): GPUTextureView {
    // Pass 1: Calculate Circle of Confusion
    this.renderCoCPass(gBufferBindGroup);

    // Pass 2: Near blur (foreground)
    this.renderNearBlurPass(inputTexture, gBufferBindGroup);

    // Pass 3: Far blur (background)
    this.renderFarBlurPass(inputTexture, gBufferBindGroup);

    // Pass 4: Composite all layers
    this.renderCompositePass(inputTexture, gBufferBindGroup);

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

  public update(_dt: number): void {
    // Update DOF parameters if needed (e.g., auto-focus)
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const folderName = 'Depth of Field';

    // Add interactive controls for physical lens parameters
    debugUI.addInteractiveControl(folderName, this, 'focusDistance', 'Focus Distance (m)', {
      min: 0.1,
      max: 100.0,
      step: 0.1,
    });

    debugUI.addInteractiveControl(folderName, this, 'aperture', 'Aperture (f-number)', {
      min: 1.0,
      max: 22.0,
      step: 0.1,
    });

    debugUI.addInteractiveControl(folderName, this, 'focalLength', 'Focal Length (m)', {
      min: 0.01,
      max: 0.2,
      step: 0.001,
    });

    debugUI.addInteractiveControl(folderName, this, 'sensorHeight', 'Sensor Height (m)', {
      min: 0.001,
      max: 0.05,
      step: 0.001,
    });

    // Add read-only info
    debugUI.addDebugControl(folderName, this, 'focusDistance', 'Current Focus Distance');
    debugUI.addDebugControl(folderName, this, 'aperture', 'Current Aperture');
  }

  public override renderDebug(): void {
    // Implement debug visualization if needed
  }

  public dispose(): void {
    // Clean up GPU resources
    if (this.cocBuffer) this.cocBuffer.destroy();
    if (this.nearBlurBuffer) this.nearBlurBuffer.destroy();
    if (this.farBlurBuffer) this.farBlurBuffer.destroy();
    if (this.finalResult) this.finalResult.destroy();
    if (this.dofParamsBuffer) this.dofParamsBuffer.destroy();
  }
}
