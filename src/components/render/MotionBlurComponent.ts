import { mat4 } from 'gl-matrix';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Engine } from '../../core/engine/Engine';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { Render } from '../../renderer/core/pipeline/Render';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { Component } from '../../core/ecs/Component';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';

/**
 * Camera Motion Blur Component
 *
 * Implements camera-based motion blur by comparing current and previous
 * camera ViewProjection matrices to calculate per-pixel velocity vectors.
 *
 * Algorithm:
 * 1. Reconstruct world position from depth buffer
 * 2. Project to previous frame's screen space
 * 3. Calculate velocity vector (current UV - previous UV)
 * 4. Sample texture along velocity vector
 * 5. Weighted average of samples
 *
 * Parameters:
 * - blurStrength: Controls blur intensity (0.0 = no blur, 1.0 = full blur)
 * - numSamples: Number of samples per pixel (4-16, quality vs performance)
 */
export class MotionBlurComponent extends Component {
  // Technique and resources
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private renderPassManager!: RenderPassManager;
  private result!: RenderTarget;

  // Motion blur parameters (uniform buffer: 144 bytes)
  // mat4x4 (64 bytes) + mat4x4 (64 bytes) + 4 floats (16 bytes) = 144 bytes
  private paramsBuffer!: GPUBuffer;
  private _blurStrength: number = 1.0; // Blur intensity
  private _numSamples: number = 6; // Sample count

  // Previous frame matrices for velocity calculation
  private previousViewProjection: mat4 = mat4.create();
  private currentInvViewProjection: mat4 = mat4.create();

  // ✅ Cache bind groups per texture to avoid incorrect reuse
  private bindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public async load(): Promise<void> {
    // Load technique
    this.technique = await Technique.getAsync('motion_blur.tech');

    // Load fullscreen quad mesh
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    // Get texture format from quality settings
    const qualitySettings = QualitySettings.getInstance();
    const hdrTexture = qualitySettings.getSettings().hdrTexture;

    // Create result render target
    this.result = new RenderTarget();
    this.result.createRT('motion_blur_result.dds', Render.width, Render.height, hdrTexture, false);

    // Create uniform buffer for motion blur parameters
    // Layout: prevVP (64) + invVP (64) + blurStrength (4) + numSamples (4) + padding (8) = 144 bytes
    this.paramsBuffer = GPUUtils.createBuffer(
      'motion_blur_params_buffer',
      144,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Initialize with identity matrices
    mat4.identity(this.previousViewProjection);
    mat4.identity(this.currentInvViewProjection);

    // Initial update
    this.updateParams();
  }

  /**
   * Update motion blur parameters in GPU buffer
   */
  private updateParams(): void {
    // Create buffer data: prevVP + invVP + params
    const bufferData = new Float32Array(36); // 144 bytes / 4 = 36 floats

    // Copy previous ViewProjection (16 floats)
    bufferData.set(this.previousViewProjection, 0);

    // Copy current inverse ViewProjection (16 floats)
    bufferData.set(this.currentInvViewProjection, 16);

    // Copy parameters (4 floats)
    bufferData[32] = this._blurStrength;
    bufferData[33] = this._numSamples;
    bufferData[34] = 0.0; // padding
    bufferData[35] = 0.0; // padding

    GPUUtils.writeBuffer(this.paramsBuffer, 0, bufferData);
  }

  /**
   * Update camera matrices for velocity calculation
   */
  private updateCameraMatrices(): void {
    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    if (!mainCamera) return;

    const cameraComponent = mainCamera.getComponent('camera');
    if (!cameraComponent) return;

    // Get current ViewProjection matrix
    const camera = (cameraComponent as any).getCamera();
    const currentVP = camera.getViewProjection();

    // Calculate inverse ViewProjection
    mat4.invert(this.currentInvViewProjection, currentVP);

    // Update parameters buffer
    this.updateParams();

    // Store current VP as previous for next frame
    mat4.copy(this.previousViewProjection, currentVP);
  }

  /**
   * Apply motion blur effect
   * @param inputTexture - HDR scene texture
   * @param depthTexture - Depth buffer texture
   * @returns Motion blurred texture
   */
  public apply(inputTexture: GPUTextureView, gBufferBindGroup: GPUBindGroup): GPUTextureView {
    // Update camera matrices before rendering
    this.updateCameraMatrices();

    // ✅ Get or create cached bind group for this texture
    let cachedBindGroup = this.bindGroupCache.get(inputTexture);
    if (!cachedBindGroup) {
      cachedBindGroup = BindGroupFactory.createBindGroup(
        'motion_blur_params_cached',
        this.technique.getPipeline().getBindGroupLayout(2),
        [
          {
            binding: 0,
            resource: inputTexture, // Input HDR scene
          },
          {
            binding: 1,
            resource: SamplerLibrary.simpleSampler, // Linear sampler
          },
          {
            binding: 2,
            resource: {
              buffer: this.paramsBuffer,
            },
          },
        ],
      );
      this.bindGroupCache.set(inputTexture, cachedBindGroup);
    }

    // Execute motion blur pass using custom pass execution
    this.renderPassManager.executeMotionBlurPass(
      this.fullscreenQuadMesh,
      this.technique,
      cachedBindGroup, // ✅ Use cached bind group
      gBufferBindGroup,
      this.result,
    );

    return this.result.getView();
  }

  public resize(): void {
    const qualitySettings = QualitySettings.getInstance();
    const hdrTexture = qualitySettings.getSettings().hdrTexture;

    this.result.createRT('motion_blur_result.dds', Render.width, Render.height, hdrTexture, false);

    // ✅ Clear cache on resize (textures recreated)
    this.bindGroupCache.clear();
  }

  /**
   * Set blur strength (0.0 = no blur, 1.0 = full blur)
   */
  public set blurStrength(value: number) {
    this._blurStrength = Math.max(0.0, Math.min(1.0, value));
    this.updateParams();
  }

  public get blurStrength(): number {
    return this._blurStrength;
  }

  /**
   * Set number of samples (quality vs performance)
   * Recommended: 4-16 samples
   */
  public set numSamples(value: number) {
    this._numSamples = Math.max(4, Math.min(32, Math.round(value)));
    this.updateParams();
  }

  public get numSamples(): number {
    return this._numSamples;
  }

  public hasLoaded(): boolean {
    return (
      this.technique !== undefined &&
      this.fullscreenQuadMesh !== undefined &&
      this.result !== undefined
    );
  }

  public update(_dt: number): void {
    // Camera matrices updated in apply() before rendering
  }

  public override renderInMenu(): void {}

  public override renderDebug(): void {
    // Implement debug visualization if needed
  }

  public dispose(): void {
    // Clean up GPU resources
    if (this.result) this.result.destroy();
    if (this.paramsBuffer) this.paramsBuffer.destroy();
  }
}
