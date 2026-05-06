import { Render } from '../pipeline/Render';
import { RenderTarget } from '../../resources/RenderTarget';
import { Technique } from '../../resources/Technique';
import { Mesh } from '../../resources/Mesh';
import { BindGroupFactory } from '../factories/BindGroupFactory';
import { Camera } from '../../../core/math/Camera';
import { mat4 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';
import { RenderKey } from './RenderKeyManager';
import { PipelineBindGroupLayouts } from '../../../types/PipelineBindGroupLayouts.enum';

/**
 * VelocityBufferManager
 *
 * Sistema independiente que genera un velocity buffer (motion vectors) para efectos temporales.
 *
 * **Características:**
 * - Calcula velocidad en screen space (píxeles/frame)
 * - Usa previous ViewProjection matrix para reprojección
 * - Formato RG16Float (2 canales suficientes para X,Y)
 * - Se activa solo si algún componente lo necesita
 *
 * **Componentes que lo usan:**
 * - SMAA T2x (reprojección temporal)
 *
 * **Uso:**
 * ```typescript
 * const velocityMgr = VelocityBufferManager.getInstance();
 * velocityMgr.setEnabled(true);
 * velocityMgr.generate(camera);
 * const velocityTexture = velocityMgr.getVelocityTextureView();
 * ```
 */
export class VelocityBufferManager {
  private static instance: VelocityBufferManager;

  private device!: GPUDevice;
  private enabled: boolean = false;
  private isInitialized: boolean = false;

  // Velocity buffer render target
  private velocityRT!: RenderTarget;

  // Velocity generation technique
  private velocityTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;

  // Per-object velocity technique (writes correct velocity for moving geometry)
  private perObjectTechnique!: Technique;
  // Bind group that exposes previousVPBuffer via the BufferUniform layout (1 binding, VS+FS)
  private previousVPBufferUniformBindGroup!: GPUBindGroup;

  // Bind groups
  private velocityBindGroup!: GPUBindGroup;

  // Persistent uniform buffers for velocity generation (reused every frame, zero GPU alloc)
  private previousVPBuffer!: GPUBuffer; // unjittered VP from last frame
  private currentUnjitteredInvVPBuffer!: GPUBuffer; // unjittered inv-VP from current frame

  // Previous frame camera matrices
  private previousViewProjection: mat4 = mat4.create();
  private hasHistory: boolean = false;

  private constructor() {}

  public static getInstance(): VelocityBufferManager {
    if (!VelocityBufferManager.instance) {
      VelocityBufferManager.instance = new VelocityBufferManager();
    }
    return VelocityBufferManager.instance;
  }

  /**
   * Inicializa el velocity buffer manager
   */
  public async initialize(width: number, height: number): Promise<void> {
    this.device = Render.getInstance().getDevice()!;

    // Load velocity technique
    this.velocityTechnique = await Technique.getAsync('utility/velocity_buffer.tech');
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    // Load per-object velocity technique
    this.perObjectTechnique = await Technique.getAsync('utility/velocity_per_object.tech');

    // Create velocity render target (RGBA16Float - usar formato HDR estándar)
    this.velocityRT = new RenderTarget();
    this.velocityRT.createRT(
      'velocity_buffer',
      width,
      height,
      'rgba16float', // Formato HDR estándar (velocity en RG, BA sin usar)
      0, // No extra usage
    );

    // Pre-allocate persistent uniform buffers (reused every frame, zero GPU alloc per-frame)
    this.previousVPBuffer = this.device.createBuffer({
      label: 'previous_view_projection',
      size: 64, // mat4x4<f32> = 64 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.currentUnjitteredInvVPBuffer = this.device.createBuffer({
      label: 'current_unjittered_inv_view_projection',
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Bind group is created once — only buffer *contents* change per frame via writeBuffer.
    // Bind groups reference the GPUBuffer objects, not their data, so no recreation needed.
    this.velocityBindGroup = BindGroupFactory.createBindGroup(
      'velocity_generation_bindgroup',
      this.velocityTechnique.getPipeline()!.getBindGroupLayout(2),
      [
        { binding: 0, resource: { buffer: this.previousVPBuffer } },
        { binding: 1, resource: { buffer: this.currentUnjitteredInvVPBuffer } },
      ],
    );

    // Bind previousVPBuffer under the BufferUniform layout (1 VERTEX+FRAGMENT binding).
    // Used by the per-object velocity pass at group(1).
    this.previousVPBufferUniformBindGroup = BindGroupFactory.createBindGroup(
      'velocity_per_object_prevVP_bindgroup',
      BindGroupFactory.getLayoutFromEnum(PipelineBindGroupLayouts.BUFFER_UNIFORM),
      [{ binding: 0, resource: { buffer: this.previousVPBuffer } }],
    );

    this.isInitialized = true;
  }

  /**
   * Activa o desactiva la generación del velocity buffer
   */
  public setEnabled(enabled: boolean): void {
    if (this.enabled !== enabled) {
      this.enabled = enabled;

      if (!enabled) {
        // Reset history cuando se desactiva
        this.hasHistory = false;
      }
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Genera el velocity buffer para el frame actual
   *
   * **Algoritmo:**
   * 1. Para cada píxel, reconstruir posición world del frame actual
   * 2. Reproyectar esa posición usando previous ViewProjection
   * 3. Calcular diferencia: velocity = currentUV - previousUV
   * 4. Escribir velocity en RG16Float texture
   *
   * @param camera - Cámara actual
   * @param depthTexture - Depth buffer del frame actual
   * @param gBufferBindGroup - Bind group con depth y cameraUniforms
   */
  public generate(camera: Camera, gBufferBindGroup: GPUBindGroup): void {
    if (!this.enabled) return;

    // Both matrices must be unjittered so that static-scene pixels produce zero velocity.
    // Using the jittered VP for either causes the jitter-sign alternation (A→B→A→B) to
    // appear as a per-frame oscillation in the velocity vector → camera vibration.
    const currentUnjitteredVP = camera.getUnjitteredViewProjection();
    const currentUnjitteredInvVP = camera.getUnjitteredInvViewProjection();

    // En el primer frame, no hay velocidad (no hay historia)
    if (!this.hasHistory) {
      this.clearVelocityBuffer();
      mat4.copy(this.previousViewProjection, currentUnjitteredVP);
      this.hasHistory = true;
      return;
    }

    // Upload both matrices — bind group references the buffers, GPU reads data at draw time
    this.device.queue.writeBuffer(
      this.previousVPBuffer,
      0,
      new Float32Array(this.previousViewProjection as unknown as ArrayLike<number>),
    );
    this.device.queue.writeBuffer(
      this.currentUnjitteredInvVPBuffer,
      0,
      new Float32Array(currentUnjitteredInvVP as unknown as ArrayLike<number>),
    );

    // Ejecutar velocity generation pass manualmente
    this.executeVelocityPass(gBufferBindGroup);

    // Guardar VP unjittered actual como "previous" para el siguiente frame
    mat4.copy(this.previousViewProjection, currentUnjitteredVP);
  }

  /**
   * Limpia el velocity buffer a (0, 0)
   */
  private clearVelocityBuffer(): void {
    const commandEncoder = this.device.createCommandEncoder({
      label: 'velocity_buffer_clear',
    });

    const renderPass = commandEncoder.beginRenderPass({
      label: 'velocity_clear_pass',
      colorAttachments: [
        {
          view: this.velocityRT.getRenderView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Ejecuta el render pass de velocity generation
   */
  private executeVelocityPass(gBufferBindGroup: GPUBindGroup): void {
    const encoder = Render.getInstance().getCommandEncoder();

    const renderPass = encoder.beginRenderPass({
      label: 'velocity_generation_pass',
      colorAttachments: [
        {
          view: this.velocityRT.getRenderView(),
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });

    const pipeline = this.velocityTechnique.getPipeline()!;
    renderPass.setPipeline(pipeline);
    renderPass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup()); // Camera
    renderPass.setBindGroup(1, gBufferBindGroup);
    renderPass.setBindGroup(2, this.velocityBindGroup); // Previous VP

    this.fullscreenQuadMesh.activate(renderPass);
    this.fullscreenQuadMesh.renderGroup(renderPass);

    renderPass.end();
  }

  /**
   * Obtiene la textura del velocity buffer para usar en otros shaders
   */
  public getVelocityTextureView(): GPUTextureView {
    return this.velocityRT.getView();
  }

  /**
   * Obtiene el render target del velocity buffer
   */
  public getVelocityRenderTarget(): RenderTarget {
    return this.velocityRT;
  }

  /**
   * Per-object velocity pass — overwrites velocity for dynamic (moving) objects.
   *
   * The preceding fullscreen camera-velocity pass only accounts for camera motion.
   * Objects that moved between frames need an additional pass that uses their
   * current AND previous model matrices to emit the correct screen-space velocity.
   *
   * Runs with less-equal depth testing (read-only) so occluded objects do NOT
   * overwrite the velocity of foreground geometry.
   *
   * Only non-instanced solid render keys are processed.  Instanced geometry is
   * rarely dynamic and would require a separate per-instance approach.
   *
   * @param renderKeys    Visible solid render keys (e.g. from camera.getCulledKeys())
   * @param depthView     GBuffer depth view for depth testing
   */
  public generatePerObject(renderKeys: RenderKey[], depthView: GPUTextureView): void {
    if (!this.enabled || !this.isInitialized || !this.hasHistory) return;

    const encoder = Render.getInstance().getCommandEncoder();

    const pass = encoder.beginRenderPass({
      label: 'velocity_per_object_pass',
      colorAttachments: [
        {
          view: this.velocityRT.getRenderView(),
          loadOp: 'load', // preserve the fullscreen camera-velocity pass result
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthReadOnly: true,
        // depthLoadOp / depthStoreOp must NOT be set when depthReadOnly is true (WebGPU spec)
      },
    });

    this.perObjectTechnique.activatePipeline(pass);
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup()); // CameraUniforms
    pass.setBindGroup(1, this.previousVPBufferUniformBindGroup); // previousVP

    for (const key of renderKeys) {
      // Skip instanced geometry — per-instance previous matrices not supported yet
      if (key.isInstanced) continue;

      pass.setBindGroup(2, key.transform.getModelBindGroup()); // ObjectUniforms (cur + prev)
      key.mesh.activate(pass);
      key.mesh.renderGroup(pass);
    }

    pass.end();
  }

  /**
   * Redimensiona el velocity buffer
   */
  public resize(width: number, height: number): void {
    if (!this.isInitialized) {
      return;
    }
    this.velocityRT.createRT('velocity_buffer', width, height, 'rgba16float', 0);

    // Reset history después de resize
    this.hasHistory = false;
  }

  /**
   * Libera recursos GPU
   */
  public destroy(): void {
    this.velocityRT.destroy();
  }
}
