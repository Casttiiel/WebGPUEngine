import { mat4, vec2, vec4 } from 'gl-matrix';
import { Mesh } from '../resources/Mesh';
import { Texture } from '../resources/Texture';
import { Technique } from '../resources/Technique';
import { GPUUtils } from './utils/GPUUtils';

interface UIUniformsData {
  transform: mat4;
  tint: vec4;
  minUV: vec2;
  maxUV: vec2;
}

/**
 * Static utility class for UI rendering operations.
 *
 * Coordinate system:
 *  - All widget positions / sizes are defined in a 1920×1080 reference space.
 *  - At runtime a single `globalScale = min(physW/1920, physH/1080)` is applied.
 *  - A letterbox offset centres the scaled canvas on screen.
 *  - The orthographic projection maps physical pixels to WebGPU clip space.
 */
export class UIRenderUtils {
  private static device: GPUDevice;
  private static quadMesh: Mesh | null = null;
  private static standardTechnique: Technique | null = null;
  private static additiveTechnique: Technique | null = null;
  private static initialized = false;
  private static orthoProjection: mat4 = mat4.create();
  private static devicePixelRatio: number = 1;
  private static screenWidth: number = 1920;
  private static screenHeight: number = 1080;
  private static screenSizeChanged: boolean = false;

  // ── Uniform buffer ring pool ─────────────────────────────────────────────
  // Pre-allocated buffers + bind groups reused every frame via writeBuffer.
  // Avoids ~2 allocations per widget per frame (one GPUBuffer + one GPUBindGroup).
  private static uniformBufferPool: GPUBuffer[] = [];
  private static uniformBindGroupPool: GPUBindGroup[] = [];
  private static uniformPoolIndex = 0;
  private static readonly UNIFORM_POOL_SIZE = 128;
  private static readonly reusableUniformData = new Float32Array(24); // 96 bytes scratch

  // ── Texture bind group cache ─────────────────────────────────────────────
  // Keyed per technique to handle the (unlikely) case of layout differences.
  private static textureBGStandard: Map<Texture, GPUBindGroup> = new Map();
  private static textureBGAdditive: Map<Texture, GPUBindGroup> = new Map();

  // Reference resolution — all JSON coords are in this space
  public static readonly REFERENCE_WIDTH = 1920;
  public static readonly REFERENCE_HEIGHT = 1080;

  // ── Screen size accessors ────────────────────────────────────────────────

  public static getScreenWidth(): number {
    return this.screenWidth;
  }

  public static getScreenHeight(): number {
    return this.screenHeight;
  }

  public static getDevicePixelRatio(): number {
    return this.devicePixelRatio;
  }

  /**
   * Single uniform scale factor: min(physW/1920, physH/1080).
   * Guarantees aspect-ratio preservation — no deformation.
   */
  public static getGlobalScale(): number {
    const scaleX = this.screenWidth / this.REFERENCE_WIDTH;
    const scaleY = this.screenHeight / this.REFERENCE_HEIGHT;
    return Math.min(scaleX, scaleY);
  }

  /**
   * Letterbox offsets (physical px) that centre the 1920×1080 canvas on screen.
   * canvasOffsetX = (physW − 1920 * gs) / 2
   * canvasOffsetY = (physH − 1080 * gs) / 2
   */
  public static getCanvasOffset(): [number, number] {
    const gs = this.getGlobalScale();
    const ox = (this.screenWidth - this.REFERENCE_WIDTH * gs) / 2;
    const oy = (this.screenHeight - this.REFERENCE_HEIGHT * gs) / 2;
    return [ox, oy];
  }

  public static hasScreenSizeChanged(): boolean {
    return this.screenSizeChanged;
  }

  public static resetScreenSizeChanged(): void {
    this.screenSizeChanged = false;
  }

  /**
   * Initialize the UI rendering system
   * Must be called once before any rendering
   */
  public static async initialize(): Promise<void> {
    if (this.initialized) {
      console.warn('UIRenderUtils: Already initialized');
      return;
    }

    this.device = GPUUtils.getDevice();

    // Initialize DPR immediately
    this.devicePixelRatio = window.devicePixelRatio || 1;

    // Load UI quad mesh
    try {
      this.quadMesh = await Mesh.get('ui/unit_plane_xy_ui.obj');
    } catch (error) {
      console.error('UIRenderUtils: Failed to load UI quad mesh', error);
      throw error;
    }

    // Load techniques
    try {
      this.standardTechnique = await Technique.getAsync('ui/ui.tech');
      this.additiveTechnique = await Technique.getAsync('ui/ui_additive.tech');
    } catch (error) {
      console.error('UIRenderUtils: Failed to load UI techniques', error);
      throw error;
    }

    this.initialized = true;
    this.initializeUniformPool();

    // Initialize default screen size (will be updated by ModuleUI)
    this.updateScreenSize(1920, 1080, 1);
  }

  /**
   * Update screen dimensions and recalculate orthographic projection.
   * @param physicalWidth  canvas.width  (physical pixels, DPR already baked in)
   * @param physicalHeight canvas.height
   * @param dpr            window.devicePixelRatio (needed for scaleWithScreen:false elements)
   */
  public static updateScreenSize(
    physicalWidth: number,
    physicalHeight: number,
    dpr: number = window.devicePixelRatio || 1,
  ): void {
    if (this.screenWidth !== physicalWidth || this.screenHeight !== physicalHeight) {
      this.screenSizeChanged = true;
    }

    this.screenWidth = physicalWidth;
    this.screenHeight = physicalHeight;
    this.devicePixelRatio = dpr;

    // Create orthographic projection for UI (2D) in physical pixel space
    // Maps physical dimensions to clip space
    mat4.ortho(
      this.orthoProjection,
      0, // left
      physicalWidth, // right
      physicalHeight, // bottom (flipped for UI)
      0, // top (flipped for UI)
      -1, // near
      1, // far
    );
  }

  /** Pre-allocate the uniform ring buffer pool once after techniques are loaded. */
  private static initializeUniformPool(): void {
    const layout = this.standardTechnique!.getBindGroupLayout(0)!;
    for (let i = 0; i < this.UNIFORM_POOL_SIZE; i++) {
      const buffer = this.device.createBuffer({
        label: `ui_uniform_buffer_${i}`,
        size: 96,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroup = this.device.createBindGroup({
        label: `ui_uniform_bind_group_${i}`,
        layout,
        entries: [{ binding: 0, resource: { buffer } }],
      });
      this.uniformBufferPool.push(buffer);
      this.uniformBindGroupPool.push(bindGroup);
    }
  }

  /** Call once per frame before rendering any widgets to reset the ring index. */
  public static beginFrame(): void {
    this.uniformPoolIndex = 0;
  }

  /**
   * Clean up GPU resources
   */
  public static destroy(): void {
    if (!this.initialized) return;

    this.quadMesh?.release();
    this.standardTechnique?.release();
    this.additiveTechnique?.release();

    for (const buf of this.uniformBufferPool) buf.destroy();
    this.uniformBufferPool = [];
    this.uniformBindGroupPool = [];
    this.uniformPoolIndex = 0;
    this.textureBGStandard.clear();
    this.textureBGAdditive.clear();

    this.quadMesh = null;
    this.standardTechnique = null;
    this.additiveTechnique = null;
    this.initialized = false;
  }

  /**
   * Render a bitmap (texture) with the given transform and parameters
   * @param pass - The render pass encoder
   * @param texture - The texture to render
   * @param transform - World transform matrix (position, rotation, scale)
   * @param tint - Color tint (RGBA, default white)
   * @param minUV - Minimum UV coordinates (default [0, 0])
   * @param maxUV - Maximum UV coordinates (default [1, 1])
   * @param additive - Use additive blending instead of alpha blending
   */
  public static renderBitmap(
    pass: GPURenderPassEncoder,
    texture: Texture,
    transform: mat4,
    tint: vec4 = vec4.fromValues(1, 1, 1, 1),
    minUV: vec2 = vec2.fromValues(0, 0),
    maxUV: vec2 = vec2.fromValues(1, 1),
    additive: boolean = false,
  ): void {
    if (!this.initialized) {
      console.error('UIRenderUtils: Not initialized, call initialize() first');
      return;
    }

    if (!this.quadMesh || !this.standardTechnique || !this.additiveTechnique) {
      console.error('UIRenderUtils: Required resources not loaded');
      return;
    }

    // Project widget transform (physical px) into clip space
    const finalTransform = mat4.create();
    mat4.multiply(finalTransform, this.orthoProjection, transform);

    // Select technique based on blend mode
    const technique = additive ? this.additiveTechnique : this.standardTechnique;

    // Activate technique (sets pipeline)
    technique.activatePipeline(pass);

    // Bind group 0: UIUniforms — use ring-buffer pool (avoids per-frame GPUBuffer allocation)
    let uniformBuffer: GPUBuffer;
    let uniformBindGroup: GPUBindGroup;
    if (this.uniformPoolIndex < this.UNIFORM_POOL_SIZE) {
      uniformBuffer = this.uniformBufferPool[this.uniformPoolIndex];
      uniformBindGroup = this.uniformBindGroupPool[this.uniformPoolIndex];
      this.uniformPoolIndex++;
      this.writeUniformData(uniformBuffer, finalTransform, tint, minUV, maxUV);
    } else {
      // Pool exhausted (>128 UI draws this frame) — fall back to one-shot allocation
      uniformBuffer = this.createUniformBufferForDraw({
        transform: finalTransform,
        tint,
        minUV,
        maxUV,
      });
      uniformBindGroup = this.createUniformBindGroup(technique, uniformBuffer);
    }
    pass.setBindGroup(0, uniformBindGroup);

    // Bind group 1: Texture + Sampler — cached per Texture instance (never recreates for the same texture)
    const textureBGCache = additive ? this.textureBGAdditive : this.textureBGStandard;
    let textureBindGroup = textureBGCache.get(texture);
    if (!textureBindGroup) {
      textureBindGroup = this.createTextureBindGroup(technique, texture);
      textureBGCache.set(texture, textureBindGroup);
    }
    pass.setBindGroup(1, textureBindGroup);

    // Activate mesh (set vertex/index buffers)
    this.quadMesh.activate(pass);

    // Draw call
    this.quadMesh.renderGroup(pass);
  }

  /** Write uniform data into a persistent pool buffer via queue.writeBuffer. */
  private static writeUniformData(
    buffer: GPUBuffer,
    transform: mat4,
    tint: vec4,
    minUV: vec2,
    maxUV: vec2,
  ): void {
    const d = UIRenderUtils.reusableUniformData;
    d.set(transform as Float32Array, 0); // mat4  → floats 0-15  (64 bytes)
    d.set(tint as Float32Array, 16); // vec4  → floats 16-19 (16 bytes)
    d.set(minUV as Float32Array, 20); // vec2  → floats 20-21 (8 bytes)
    d.set(maxUV as Float32Array, 22); // vec2  → floats 22-23 (8 bytes)
    GPUUtils.writeBuffer(buffer, 0, d);
  }

  /**
   * Create a unique uniform buffer for a single draw call
   * This prevents buffer sharing bugs where all draw calls use the last written data
   */
  private static createUniformBufferForDraw(data: UIUniformsData): GPUBuffer {
    const uniformData = new Float32Array(96 / 4); // 96 bytes = 24 floats

    // mat4 transform (64 bytes = 16 floats)
    uniformData.set(data.transform as Float32Array, 0);

    // vec4 tint (16 bytes = 4 floats)
    uniformData.set(data.tint as Float32Array, 16);

    // vec2 minUV (8 bytes = 2 floats)
    uniformData.set(data.minUV as Float32Array, 20);

    // vec2 maxUV (8 bytes = 2 floats)
    uniformData.set(data.maxUV as Float32Array, 22);

    // Create buffer with data
    const buffer = this.device.createBuffer({
      label: 'ui_uniform_buffer_per_draw',
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });

    new Float32Array(buffer.getMappedRange()).set(uniformData);
    buffer.unmap();

    return buffer;
  }

  /**
   * Create bind group for UIUniforms (group 0)
   */
  private static createUniformBindGroup(
    technique: Technique,
    uniformBuffer: GPUBuffer,
  ): GPUBindGroup {
    const layout = technique.getBindGroupLayout(0); // BufferUniform layout

    if (!layout) {
      throw new Error('UIRenderUtils: Failed to get bind group layout 0');
    }

    return this.device.createBindGroup({
      label: 'ui_uniform_bind_group',
      layout: layout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: uniformBuffer, // Use provided buffer
          },
        },
      ],
    });
  }

  /**
   * Create bind group for texture + sampler (group 1)
   */
  private static createTextureBindGroup(technique: Technique, texture: Texture): GPUBindGroup {
    const layout = technique.getBindGroupLayout(1); // SingleTexture layout

    if (!layout) {
      throw new Error('UIRenderUtils: Failed to get bind group layout 1');
    }

    const textureView = texture.getTextureView();
    const sampler = texture.getSampler();

    if (!textureView || !sampler) {
      throw new Error('UIRenderUtils: Texture or sampler not available');
    }

    return this.device.createBindGroup({
      label: 'ui_texture_bind_group',
      layout: layout,
      entries: [
        {
          binding: 0,
          resource: textureView,
        },
        {
          binding: 1,
          resource: sampler,
        },
      ],
    });
  }

  /** Atlas de la fuente bitmap (ui/fonts/font.png): 8x8 celdas, ASCII 32 (' ') a 95 ('_'). */
  private static readonly FONT_GRID = 8;
  private static readonly FONT_FIRST_CHAR = 32;
  private static readonly FONT_LAST_CHAR = 95;

  /** Ancho que ocupa un texto con renderText (px físicos). */
  public static measureText(text: string, charWidth: number, spacing = 0.8): number {
    return text.length > 0 ? (text.length - 1) * charWidth * spacing + charWidth : 0;
  }

  /**
   * Dibuja texto con la fuente bitmap. Solo mayúsculas: las minúsculas se convierten y los
   * caracteres fuera del atlas se dejan como espacio.
   * @param origin  Esquina superior izquierda del texto en px físicos
   * @param charSize Tamaño de cada carácter en px físicos [ancho, alto]
   * @param spacing Avance entre caracteres como fracción del ancho (los glifos tienen margen)
   */
  public static renderText(
    pass: GPURenderPassEncoder,
    text: string,
    fontTexture: Texture,
    origin: vec2,
    charSize: vec2,
    tint: vec4 = vec4.fromValues(1, 1, 1, 1),
    spacing = 0.8,
  ): void {
    if (!this.initialized) {
      console.error('UIRenderUtils: Not initialized, call initialize() first');
      return;
    }

    const grid = this.FONT_GRID;
    const cell = 1 / grid;
    const [w, h] = [charSize[0]!, charSize[1]!];
    const transform = mat4.create();
    const uvMin = vec2.create();
    const uvMax = vec2.create();
    const upper = text.toUpperCase();

    for (let i = 0; i < upper.length; i++) {
      const code = upper.charCodeAt(i);
      if (code <= this.FONT_FIRST_CHAR || code > this.FONT_LAST_CHAR) continue; // espacio / fuera del atlas
      const index = code - this.FONT_FIRST_CHAR;
      const col = index % grid;
      const row = Math.floor(index / grid);
      vec2.set(uvMin, col * cell, row * cell);
      vec2.set(uvMax, (col + 1) * cell, (row + 1) * cell);

      // El quad unitario está centrado en el origen: trasladar al centro de la celda.
      mat4.fromTranslation(transform, [origin[0]! + i * w * spacing + w / 2, origin[1]! + h / 2, 0]);
      mat4.scale(transform, transform, [w, h, 1]);
      this.renderBitmap(pass, fontTexture, transform, tint, uvMin, uvMax);
    }
  }
}
