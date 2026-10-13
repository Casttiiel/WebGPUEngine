import { mat4, vec2, vec3, vec4 } from 'gl-matrix';
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
  // Per-draw scratch (renderBitmap/renderText run per glyph every frame: no allocations)
  private static readonly finalTransformScratch = mat4.create();
  private static readonly glyphTransform = mat4.create();
  private static readonly glyphUvMin = vec2.create();
  private static readonly glyphUvMax = vec2.create();
  private static readonly glyphVec = vec3.create();
  private static readonly WHITE: vec4 = vec4.fromValues(1, 1, 1, 1);
  private static readonly UV_MIN: vec2 = vec2.fromValues(0, 0);
  private static readonly UV_MAX: vec2 = vec2.fromValues(1, 1);

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
    tint: vec4 = UIRenderUtils.WHITE,
    minUV: vec2 = UIRenderUtils.UV_MIN,
    maxUV: vec2 = UIRenderUtils.UV_MAX,
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
    // Scratch is safe: both uniform paths below copy it out before returning
    const finalTransform = mat4.multiply(this.finalTransformScratch, this.orthoProjection, transform);

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

  // ── Texto bitmap ─────────────────────────────────────────────────────────
  //
  // Dos formatos de atlas:
  //  - Con métricas (<fuente>.json, generado por scripts/generate-ui-font.mjs): rejilla de
  //    celdas cuadradas con los códigos 0-255 (Latin-1) y avance proporcional por carácter.
  //  - Sin métricas (ui/fonts/font.png antiguo): 8x8 celdas, ASCII 32-95, solo mayúsculas,
  //    avance fijo.

  private static fontMetrics = new Map<string, BitmapFontMetrics | null>();
  private static fontMetricsLoading = new Set<string>();

  /**
   * Métricas de una fuente: null = fuente sin métricas (formato antiguo), undefined = aún
   * cargando (la primera llamada lanza la carga).
   */
  public static getFontMetrics(fontTexturePath: string): BitmapFontMetrics | null | undefined {
    if (this.fontMetrics.has(fontTexturePath)) return this.fontMetrics.get(fontTexturePath);
    if (!this.fontMetricsLoading.has(fontTexturePath)) {
      this.fontMetricsLoading.add(fontTexturePath);
      const url = `${import.meta.env.BASE_URL}assets/textures/${fontTexturePath.replace(/.[^.]+$/, '.json')}`;
      fetch(url)
        .then((r) => (r.ok ? (r.json() as Promise<BitmapFontMetrics>) : null))
        .catch(() => null)
        .then((m) => this.fontMetrics.set(fontTexturePath, m));
    }
    return undefined;
  }

  /** Ancho (px físicos) que ocupa un texto de altura `height` px. */
  public static measureText(
    text: string,
    height: number,
    metrics: BitmapFontMetrics | null,
  ): number {
    if (!metrics) {
      return text.length > 0 ? (text.length - 1) * height * LEGACY_SPACING + height : 0;
    }
    const scale = height / metrics.cell;
    let width = 0;
    for (let i = 0; i < text.length; i++) {
      width += (metrics.advances[text.charCodeAt(i)] ?? metrics.cell * 0.5) * scale;
    }
    return width;
  }

  /**
   * Dibuja una línea de texto.
   * @param origin  Esquina superior izquierda en px físicos
   * @param height  Altura de la línea en px físicos (= tamaño de celda en pantalla)
   * @param metrics Métricas de la fuente (null: atlas antiguo de 8x8 en mayúsculas)
   */
  public static renderText(
    pass: GPURenderPassEncoder,
    text: string,
    fontTexture: Texture,
    origin: vec2,
    height: number,
    tint: vec4,
    metrics: BitmapFontMetrics | null,
  ): void {
    if (!this.initialized) {
      console.error('UIRenderUtils: Not initialized, call initialize() first');
      return;
    }

    const grid = metrics?.grid ?? LEGACY_GRID;
    const cell = 1 / grid;
    const scale = metrics ? height / metrics.cell : 1;
    const transform = this.glyphTransform;
    const uvMin = this.glyphUvMin;
    const uvMax = this.glyphUvMax;
    const v = this.glyphVec;
    const str = metrics ? text : text.toUpperCase();
    // Las celdas tienen margen a la izquierda del glifo: se compensa para alinear en origin.
    let x = origin[0]! - (metrics ? metrics.padX * scale : 0);

    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      const index = metrics ? code : code - LEGACY_FIRST_CHAR;
      const visible = metrics
        ? code > 32 && code < 256 && metrics.advances[code] !== undefined
        : code > LEGACY_FIRST_CHAR && code <= LEGACY_LAST_CHAR;
      if (visible) {
        const col = index % grid;
        const row = Math.floor(index / grid);
        vec2.set(uvMin, col * cell, row * cell);
        vec2.set(uvMax, (col + 1) * cell, (row + 1) * cell);
        // El quad unitario está centrado en el origen: trasladar al centro de la celda.
        mat4.fromTranslation(transform, vec3.set(v, x + height / 2, origin[1]! + height / 2, 0));
        mat4.scale(transform, transform, vec3.set(v, height, height, 1));
        this.renderBitmap(pass, fontTexture, transform, tint, uvMin, uvMax);
      }
      x += metrics
        ? (metrics.advances[code] ?? metrics.cell * 0.5) * scale
        : height * LEGACY_SPACING;
    }
  }
}

/** Métricas de un atlas de fuente generado por scripts/generate-ui-font.mjs. */
export interface BitmapFontMetrics {
  cell: number;
  grid: number;
  padX: number;
  /** Avance horizontal por código de carácter (px de celda). */
  advances: Record<number, number>;
}

const LEGACY_GRID = 8;
const LEGACY_FIRST_CHAR = 32;
const LEGACY_LAST_CHAR = 95;
const LEGACY_SPACING = 0.8;
