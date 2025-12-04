import { Render } from '../pipeline/Render';
import { RenderTarget } from '../../resources/RenderTarget';
import { Technique } from '../../resources/Technique';
import { Mesh } from '../../resources/Mesh';
import { RenderPassManager } from '../passes/RenderPassManager';
import { BindGroupFactory } from '../factories/BindGroupFactory';
import { Camera } from '../../../core/math/Camera';
import { mat4 } from 'gl-matrix';
import { Engine } from '../../../core/engine/Engine';

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

  // Bind groups
  private velocityBindGroup!: GPUBindGroup;

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
    this.velocityTechnique = await Technique.getAsync('velocity_buffer.tech');
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    // Create velocity render target (RGBA16Float - usar formato HDR estándar)
    this.velocityRT = new RenderTarget();
    this.velocityRT.createRT(
      'velocity_buffer',
      width,
      height,
      'rgba16float', // Formato HDR estándar (velocity en RG, BA sin usar)
      0, // No extra usage
    );

    console.log('[VelocityBufferManager] Initialized', width, 'x', height);
    this.isInitialized = true;
  }

  /**
   * Activa o desactiva la generación del velocity buffer
   */
  public setEnabled(enabled: boolean): void {
    if (this.enabled !== enabled) {
      this.enabled = enabled;
      console.log('[VelocityBufferManager] Enabled:', enabled);

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

    const currentViewProjection = camera.getViewProjection();

    // En el primer frame, no hay velocidad (no hay historia)
    if (!this.hasHistory) {
      this.clearVelocityBuffer();
      mat4.copy(this.previousViewProjection, currentViewProjection);
      this.hasHistory = true;
      return;
    }

    // Crear bind group con matrices current y previous
    this.createVelocityBindGroup();

    // Ejecutar velocity generation pass manualmente
    this.executeVelocityPass(gBufferBindGroup);

    // Guardar ViewProjection actual para el siguiente frame
    mat4.copy(this.previousViewProjection, currentViewProjection);
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
   * Crea el bind group para la generación del velocity buffer
   */
  private createVelocityBindGroup(): void {
    // Crear uniform buffer con previous ViewProjection matrix
    const previousVPBuffer = this.device.createBuffer({
      label: 'previous_view_projection',
      size: 64, // mat4x4<f32> = 64 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.device.queue.writeBuffer(
      previousVPBuffer,
      0,
      new Float32Array(this.previousViewProjection as unknown as ArrayLike<number>),
    );

    // Bind group layout:
    // @group(0) = camera uniforms (current frame)
    // @group(1) = G-Buffer textures (albedo, normal, depth, sampler)
    // @group(2) = previousViewProjection
    this.velocityBindGroup = BindGroupFactory.createBindGroup(
      'velocity_generation_bindgroup',
      this.velocityTechnique.getPipeline()!.getBindGroupLayout(2),
      [
        {
          binding: 0,
          resource: {
            buffer: previousVPBuffer,
          },
        },
      ],
    );
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
   * Redimensiona el velocity buffer
   */
  public resize(width: number, height: number): void {
    if (!this.isInitialized) {
      return;
    }
    this.velocityRT.createRT('velocity_buffer', width, height, 'rg16float', 0);

    // Reset history después de resize
    this.hasHistory = false;

    console.log('[VelocityBufferManager] Resized to', width, 'x', height);
  }

  /**
   * Libera recursos GPU
   */
  public destroy(): void {
    this.velocityRT.destroy();
    console.log('[VelocityBufferManager] Destroyed');
  }
}
