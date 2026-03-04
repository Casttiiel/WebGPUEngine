import { Engine } from '../../../core/engine/Engine';
import { QualitySettings } from '../../../core/engine/QualitySettings';
import { LoadingStatus } from '../../../core/engine/LoadingStatus';
import { setupResizeEvents } from '../../../utils/ResizeEvents';
import { Texture } from '../../resources/Texture';
import { BindGroupFactory } from '../factories/BindGroupFactory';
import { MipmapGenerator } from '../processing/MipmapGenerator';
import { GPUUtils } from '../utils/GPUUtils';
import { SamplerLibrary } from '../utils/SamplerLibrary';

export class Render {
  private static instance: Render;

  // Performance optimization: Maximum 4K render resolution
  private static readonly MAX_RENDER_WIDTH = 3840;
  private static readonly MAX_RENDER_HEIGHT = 2160;

  // Objetos principales de WebGPU
  private adapter!: GPUAdapter;
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private currentCommandEncoder!: GPUCommandEncoder;
  private format: GPUTextureFormat = 'bgra8unorm';

  // Dimensiones del canvas (tamaño real del canvas)
  private static canvasWidth: number = 800;
  private static canvasHeight: number = 600;

  // Dimensiones de renderizado (pueden ser menores para render resolution)
  private static renderWidth: number = 800;
  private static renderHeight: number = 600;

  private canvas!: HTMLCanvasElement;

  private constructor() {
    // Constructor privado para patrón singleton
  }

  public async initialize(canvas: HTMLCanvasElement): Promise<boolean> {
    if (!canvas) {
      console.error('Canvas element is null or undefined');
      return false;
    }
    this.canvas = canvas;

    // Configurar tamaño del canvas considerando la densidad de píxeles del dispositivo
    const dpr = window.devicePixelRatio || 1;
    const width = Math.floor(Math.max(1, canvas.clientWidth * dpr));
    const height = Math.floor(Math.max(1, canvas.clientHeight * dpr));

    canvas.width = width;
    canvas.height = height;
    Render.canvasWidth = width;
    Render.canvasHeight = height;
    Render.updateRenderDimensions();

    console.warn(
      `Canvas initialized: ${width}x${height} (Resolution: ${Render.renderWidth}x${Render.renderHeight})`,
    );

    try {
      LoadingStatus.updateStatus('Requesting GPU adapter...', 5);
      // 1. Obtener el adaptador WebGPU que representa el hardware gráfico
      if (!navigator.gpu) {
        throw new Error('WebGPU no está soportado en este navegador');
      }

      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        throw new Error('No se encontró un adaptador WebGPU compatible');
      }
      this.adapter = adapter;

      LoadingStatus.updateStatus('Creating GPU device...', 10);
      // 2. Crear el dispositivo lógico con las características requeridas
      this.device = await this.adapter.requestDevice({
        label: `${Date.now()}`,
        requiredFeatures: ['texture-compression-bc', 'depth32float-stencil8'],
        requiredLimits: {
          maxStorageBufferBindingSize: 1024 * 1024 * 1024, // 1GB de buffer máximo
        },
      });

      LoadingStatus.updateStatus('Configuring canvas context...', 15);
      // 3. Configurar el contexto del canvas para WebGPU
      const context = canvas.getContext('webgpu');
      if (!context) {
        throw new Error('No se pudo obtener el contexto WebGPU');
      }
      this.context = context; // Configurar el formato de color preferido
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.format,
      });
      this.setupResizeObserver();

      LoadingStatus.updateStatus('Initializing GPU utilities...', 20);
      // Initialize GPUUtils with the WebGPU device
      GPUUtils.initialize(this.device);
      console.warn('GPUUtils initialized with WebGPU device');

      LoadingStatus.updateStatus('Creating sampler library...', 23);
      // Initialize SamplerLibrary with reusable samplers
      SamplerLibrary.initialize();
      console.warn('SamplerLibrary initialized with reusable samplers');

      return true;
    } catch (error) {
      console.error('Error al inicializar WebGPU:', error);
      return false;
    }
  }

  /**
   * Re-derive render width/height from the current QualitySettings.renderResolution
   * and notify all modules (resize all render targets, pipelines, etc.).
   * Call this after QualitySettings.setRenderResolution().
   */
  public static applyRenderResolution(): void {
    Render.updateRenderDimensions();
    Render.getInstance()
      .device.queue.onSubmittedWorkDone()
      .then(() => {
        Engine.getRender().onResolutionUpdated();
      });
  }

  // Update render dimensions based on quality settings
  private static updateRenderDimensions(): void {
    const renderRes = QualitySettings.getInstance().getSettings().renderResolution;

    // Calculate the scaling factor to fit within 2K limits while maintaining aspect ratio
    let scaledWidth = Render.canvasWidth;
    let scaledHeight = Render.canvasHeight;

    // If canvas exceeds 2K limits, scale down while preserving aspect ratio
    if (scaledWidth > Render.MAX_RENDER_WIDTH || scaledHeight > Render.MAX_RENDER_HEIGHT) {
      const widthScale = Render.MAX_RENDER_WIDTH / scaledWidth;
      const heightScale = Render.MAX_RENDER_HEIGHT / scaledHeight;
      const scale = Math.min(widthScale, heightScale); // Use the smaller scale to fit both dimensions

      scaledWidth = Math.floor(scaledWidth * scale);
      scaledHeight = Math.floor(scaledHeight * scale);
    }

    // Apply quality render resolution scaling
    Render.renderWidth = Math.max(1, Math.floor(scaledWidth * renderRes));
    Render.renderHeight = Math.max(1, Math.floor(scaledHeight * renderRes));
  }

  /**
   * Re-derive render width/height from the current QualitySettings.renderResolution
   * and notify all modules (resize all render targets, pipelines, etc.).
   * Call this after QualitySettings.setRenderResolution().
   */
  public static applyRenderResolution(): void {
    Render.updateRenderDimensions();
    Render.getInstance()
      .device.queue.onSubmittedWorkDone()
      .then(() => {
        Engine.getRender().onResolutionUpdated();
      });
  }

  // Ajustar el tamaño del buffer de render
  public async resizeBackBuffer(newWidth: number, newHeight: number): Promise<boolean> {
    if (Render.canvasWidth === newWidth && Render.canvasHeight === newHeight) {
      return false;
    }

    Render.canvasWidth = newWidth;
    Render.canvasHeight = newHeight;
    Render.updateRenderDimensions();

    if (this.canvas) {
      this.canvas.width = newWidth;
      this.canvas.height = newHeight;
    }

    // Reconfigurar el contexto con el nuevo tamaño
    if (this.context && this.device) {
      this.context.configure({
        device: this.device,
        format: this.format,
      });
    }

    return true;
  }

  // Comenzar un nuevo frame de renderizado
  public beginFrame(): void {
    if (!this.device || !this.context) return;

    this.currentCommandEncoder = this.device.createCommandEncoder();
  }

  // Finalizar y enviar los comandos de renderizado
  public endFrame(): void {
    if (!this.device) return;

    const commandBuffer = this.currentCommandEncoder.finish();
    this.device.queue.submit([commandBuffer]);
  }

  private setupResizeObserver(): void {
    setupResizeEvents(
      this.canvas,
      () => {},
      () => {
        const dpr = window.devicePixelRatio || 1;
        const width = Math.floor(Math.max(1, this.canvas.clientWidth * dpr));
        const height = Math.floor(Math.max(1, this.canvas.clientHeight * dpr));

        this.resizeAndNotify(width, height);
      },
    );
  }

  private resizeAndNotify(width: number, height: number): void {
    this.device.queue.onSubmittedWorkDone().then(() => {
      this.resizeBackBuffer(width, height);

      Engine.getRender().onResolutionUpdated();
    });
  }

  public static getInstance(): Render {
    if (!Render.instance) {
      Render.instance = new Render();
    }
    return Render.instance;
  }

  public static get width(): number {
    return Render.renderWidth;
  }

  public static get height(): number {
    return Render.renderHeight;
  }

  public static get canvasSize(): { width: number; height: number } {
    return { width: Render.canvasWidth, height: Render.canvasHeight };
  }

  public static get renderSize(): { width: number; height: number } {
    return { width: Render.renderWidth, height: Render.renderHeight };
  }

  // Métodos para sobrescribir temporalmente las dimensiones (útil para reflection probes)
  public static setTemporaryRenderSize(width: number, height: number): void {
    Render.renderWidth = width;
    Render.renderHeight = height;
  }

  public static restoreRenderSize(): void {
    const qualitySettings = QualitySettings.getInstance();
    const renderResolution = qualitySettings.getSettings().renderResolution;
    Render.renderWidth = Math.floor(Render.canvasWidth * renderResolution);
    Render.renderHeight = Math.floor(Render.canvasHeight * renderResolution);
  }

  public getDevice(): GPUDevice {
    return this.device;
  }

  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  public getCommandEncoder(): GPUCommandEncoder {
    return this.currentCommandEncoder;
  }

  public getFormat(): GPUTextureFormat {
    return this.format;
  }

  public getContext(): GPUCanvasContext {
    return this.context;
  }

  public destroy(): void {
    console.log('Cleaning up Render singleton...');

    try {
      // Clean up device resources if they exist
      if (this.device) {
        // Note: WebGPU device cleanup is automatic when references are released
        this.device = null as any;
      }

      // Clear context
      if (this.context) {
        this.context = null as any;
      }

      // Clear adapter
      if (this.adapter) {
        this.adapter = null as any;
      }

      // Clear command encoder
      if (this.currentCommandEncoder) {
        this.currentCommandEncoder = null as any;
      }

      BindGroupFactory.clearCache();
      MipmapGenerator.destroyInstance();
      Texture.cleanup();
      SamplerLibrary.destroy();
      GPUUtils.destroy();

      Render.instance = null as any; // Clear singleton instance

      console.log('Render singleton cleaned up successfully.');
    } catch (error) {
      console.error('Error cleaning up Render singleton:', error);
    }
  }
}
