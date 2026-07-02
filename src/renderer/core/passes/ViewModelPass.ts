import { Camera } from '../../../core/math/Camera';
import { Render } from '../pipeline/Render';
import { RenderManagerV2 } from '../managers/RenderManagerV2';
import { GPUUtils } from '../utils/GPUUtils';
import { vec3 } from 'gl-matrix';

/**
 * ViewModelPass — renders first-person view-model geometry (weapons, hands) into the
 * accumulated-light render target with a dedicated depth buffer that is cleared every
 * frame, so view-model meshes never clip against world geometry.
 *
 * Design:
 *  • Own depth texture (depth24plus), cleared to 1.0 each frame.
 *  • Composites INTO the supplied accLight colour attachment (loadOp: 'load').
 *  • Uses a dedicated Camera with identity view and a narrow FOV (default 55°) so
 *    the weapon feels natural relative to the world camera.
 *  • Bypasses GPU/HZB frustum culling — view-model objects are always visible.
 */
export class ViewModelPass {
  /** Dedicated depth texture for view-model geometry */
  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;

  /** Secondary camera used only for view-model rendering */
  private readonly camera: Camera = new Camera();

  /** FOV in degrees for the view-model camera (default 55°) */
  private fovDeg: number = 55;

  private width: number = 0;
  private height: number = 0;

  constructor() {
    // Camera starts at origin, looking down -Z → identity view matrix.
    this.camera.lookAt(
      vec3.fromValues(0, 0, 0),
      vec3.fromValues(0, 0, -1),
      vec3.fromValues(0, 1, 0),
    );
    this.camera.setNearPlane(0.01);
    this.camera.setFarPlane(50.0);
  }

  /** Call once on startup and again whenever the resolution changes. */
  public resize(width: number, height: number): void {
    this.width = width;
    this.height = height;

    this.destroyDepthTexture();

    const device = GPUUtils.getDevice();
    this.depthTexture = device.createTexture({
      label: 'viewmodel_depth',
      size: [width, height, 1],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView({ label: 'viewmodel_depth_view' });

    this.camera.setFov(this.fovDeg);
    this.camera.setViewport(width, height);
    // Refresh GPU uniforms after viewport/projection change
    this.camera.updateUniforms(0);
  }

  /**
   * Renders all VIEW_MODEL category keys into colorTargetView.
   * Call once per frame AFTER TAA/TSR to avoid temporal ghosting.
   * @param colorTargetView  colour target to composite into (loadOp: 'load')
   * @param mainCameraBindGroup  main camera bind group forwarded to group(3) in the shader
   *                             for world-space lighting calculations.
   * @param width  pixel width of colorTargetView — depth texture is resized to match if needed.
   * @param height pixel height of colorTargetView — depth texture is resized to match if needed.
   */
  public execute(
    colorTargetView: GPUTextureView,
    mainCameraBindGroup: GPUBindGroup,
    width: number,
    height: number,
  ): void {
    // Re-create depth texture whenever the target resolution changes (e.g. TSR upscales
    // from render resolution to canvas resolution).
    if (width !== this.width || height !== this.height) {
      this.resize(width, height);
    }

    if (!this.depthView) return;

    // Keep camera uniforms current (time advances, prevents stale values)
    this.camera.updateUniforms(0);

    const encoder = Render.getInstance().getCommandEncoder();
    const pass = encoder.beginRenderPass({
      label: 'viewmodel_pass',
      colorAttachments: [
        {
          view: colorTargetView,
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthView,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0.0,
      },
    });

    pass.setViewport(0, 0, this.width, this.height, 0.0, 1.0);
    pass.setScissorRect(0, 0, this.width, this.height);

    RenderManagerV2.getInstance().renderViewModelKeys(this.camera, pass, mainCameraBindGroup);

    pass.end();
  }

  /** Update view-model FOV (in degrees). Takes effect on next resize(). */
  public setFov(fovDeg: number): void {
    this.fovDeg = fovDeg;
    if (this.width > 0 && this.height > 0) {
      this.camera.setFov(fovDeg);
      this.camera.updateUniforms(0);
    }
  }

  public getCamera(): Camera {
    return this.camera;
  }

  public isReady(): boolean {
    return this.depthView !== null;
  }

  public dispose(): void {
    this.destroyDepthTexture();
  }

  private destroyDepthTexture(): void {
    this.depthTexture?.destroy();
    this.depthTexture = null;
    this.depthView = null;
  }
}
