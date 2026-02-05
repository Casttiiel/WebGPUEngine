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
 * Static utility class for UI rendering operations
 * Manages uniform buffers, bind groups, and draw calls for UI widgets
 */
export class UIRenderUtils {
  private static device: GPUDevice;
  private static uniformBuffer: GPUBuffer;
  private static quadMesh: Mesh | null = null;
  private static standardTechnique: Technique | null = null;
  private static additiveTechnique: Technique | null = null;
  private static initialized = false;
  private static orthoProjection: mat4 = mat4.create(); // Orthographic projection matrix
  private static devicePixelRatio: number = 1; // Track DPR for scale calculations
  private static screenWidth: number = 1920;
  private static screenHeight: number = 1080;
  private static screenSizeChanged: boolean = false; // Flag to track screen resize

  // Reference resolution for UI design (offsets, sizes defined in this space)
  private static readonly REFERENCE_WIDTH = 1920;
  private static readonly REFERENCE_HEIGHT = 1080;

  /**
   * Get current screen dimensions
   */
  public static getScreenWidth(): number {
    return this.screenWidth;
  }

  public static getScreenHeight(): number {
    return this.screenHeight;
  }

  /**
   * Get UI scale factor based on current screen vs reference resolution.
   * Uses minimum scale to maintain aspect ratio.
   * Compares physical pixels to reference (1920x1080 CSS) * DPR.
   */
  public static getUIScaleFactor(): number {
    // Calculate scale comparing physical pixels to reference * DPR
    const referencePhysicalWidth = this.REFERENCE_WIDTH;
    const referencePhysicalHeight = this.REFERENCE_HEIGHT;

    const scaleX = this.screenWidth / referencePhysicalWidth;
    const scaleY = this.screenHeight / referencePhysicalHeight;
    return Math.min(scaleX, scaleY);
  }

  /**
   * Get separate X and Y scale factors for non-uniform scaling.
   * Allows images to deform to match screen aspect ratio.
   * Returns [scaleX, scaleY]
   */
  public static getUIScaleFactors(): [number, number] {
    // Compare physical screen pixels to physical reference (1920x1080 * DPR)
    const referencePhysicalWidth = this.REFERENCE_WIDTH * this.devicePixelRatio;
    const referencePhysicalHeight = this.REFERENCE_HEIGHT * this.devicePixelRatio;

    const scaleX = this.screenWidth / referencePhysicalWidth;
    const scaleY = this.screenHeight / referencePhysicalHeight;

    return [scaleX, scaleY];
  }

  /**
   * Check if screen size changed this frame
   */
  public static hasScreenSizeChanged(): boolean {
    return this.screenSizeChanged;
  }

  /**
   * Reset screen size change flag (called after widgets update)
   */
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

    // Create uniform buffer for UIUniforms
    // mat4 (64 bytes) + vec4 (16 bytes) + vec2 (8 bytes) + vec2 (8 bytes) = 96 bytes
    // Align to 256 bytes for uniform buffer constraints
    this.uniformBuffer = GPUUtils.createBuffer(
      'ui_uniforms',
      256,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

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

    // Initialize default screen size (will be updated by ModuleUI)
    this.updateScreenSize(1920, 1080);
  }

  private static devicePixelRatio: number = 1;

  /**
   * Update screen dimensions and recalculate orthographic projection
   * Uses physical pixel dimensions (canvas.width/height with DPR)
   */
  public static updateScreenSize(physicalWidth: number, physicalHeight: number, dpr: number): void {
    // Detect if screen size actually changed
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

  /**
   * Clean up GPU resources
   */
  public static destroy(): void {
    if (!this.initialized) return;

    this.uniformBuffer?.destroy();
    this.quadMesh?.release();
    this.standardTechnique?.release();
    this.additiveTechnique?.release();

    this.uniformBuffer = null!;
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

    // Apply orthographic projection directly to widget transform
    // Widget is in reference space, ortho converts to clip space with built-in scaling
    const finalTransform = mat4.create();
    mat4.multiply(finalTransform, this.orthoProjection, transform);

    // Update uniform buffer with current parameters
    this.updateUniforms({ transform: finalTransform, tint, minUV, maxUV });

    // Select technique based on blend mode
    const technique = additive ? this.additiveTechnique : this.standardTechnique;

    // Activate technique (sets pipeline)
    technique.activatePipeline(pass);

    // Bind group 0: UIUniforms (BufferUniform)
    const uniformBindGroup = this.createUniformBindGroup(technique);
    pass.setBindGroup(0, uniformBindGroup);

    // Bind group 1: Texture + Sampler (SingleTexture)
    const textureBindGroup = this.createTextureBindGroup(technique, texture);
    pass.setBindGroup(1, textureBindGroup);

    // Activate mesh (set vertex/index buffers)
    this.quadMesh.activate(pass);

    // Draw call
    this.quadMesh.renderGroup(pass);
  }

  /**
   * Update uniform buffer with current UIUniforms data
   */
  private static updateUniforms(data: UIUniformsData): void {
    const uniformData = new Float32Array(96 / 4); // 96 bytes = 24 floats

    // mat4 transform (64 bytes = 16 floats)
    uniformData.set(data.transform as Float32Array, 0);

    // vec4 tint (16 bytes = 4 floats)
    uniformData.set(data.tint as Float32Array, 16);

    // vec2 minUV (8 bytes = 2 floats)
    uniformData.set(data.minUV as Float32Array, 20);

    // vec2 maxUV (8 bytes = 2 floats)
    uniformData.set(data.maxUV as Float32Array, 22);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
  }

  /**
   * Create bind group for UIUniforms (group 0)
   */
  private static createUniformBindGroup(technique: Technique): GPUBindGroup {
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
            buffer: this.uniformBuffer,
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

  /**
   * Render text using a font texture atlas
   * @param pass - The render pass encoder
   * @param text - The text string to render
   * @param fontTexture - The font atlas texture
   * @param position - Position in UI space
   * @param scale - Text scale factor
   * @param tint - Text color
   */
  public static renderText(
    _pass: GPURenderPassEncoder,
    _text: string,
    _fontTexture: Texture,
    _position: vec2,
    _scale: number = 1.0,
    _tint: vec4 = vec4.fromValues(1, 1, 1, 1),
  ): void {
    if (!this.initialized) {
      console.error('UIRenderUtils: Not initialized, call initialize() first');
      return;
    }

    // Basic text rendering implementation
    // For each character:
    // 1. Calculate UV coords in font atlas
    // 2. Calculate transform (position + offset + scale)
    // 3. Call renderBitmap with character UVs

    // This is a simplified placeholder implementation
    // Full implementation would require font metrics and atlas mapping
    console.warn('UIRenderUtils: renderText is not fully implemented yet');

    // Example for single character rendering:
    // const charWidth = 0.1 * scale;
    // const charHeight = 0.1 * scale;
    // for (let i = 0; i < text.length; i++) {
    //   const char = text[i];
    //   const uvMin = calculateCharUV(char); // Implement based on font atlas
    //   const uvMax = vec2.add(vec2.create(), uvMin, vec2.fromValues(1/16, 1/16));
    //   const transform = mat4.create();
    //   mat4.translate(transform, transform, [position[0] + i * charWidth, position[1], 0]);
    //   mat4.scale(transform, transform, [charWidth, charHeight, 1]);
    //   this.renderBitmap(pass, fontTexture, transform, tint, uvMin, uvMax);
    // }
  }
}
