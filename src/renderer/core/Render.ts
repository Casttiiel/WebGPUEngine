import { AmbientOcclusionComponent } from '@/components/render/AmbientOcclusionComponent';
import { AntialiasingComponent } from '../../components/render/AntialiasingComponent';
import { CameraComponent } from '../../components/render/CameraComponent';
import { ToneMappingComponent } from '../../components/render/ToneMappingComponent';
import { Engine } from '../../core/engine/Engine';

export class Render {
  private static instance: Render;

  // Objetos principales de WebGPU
  private adapter!: GPUAdapter; // Adaptador que representa el hardware gráfico
  private device!: GPUDevice; // Dispositivo lógico para crear recursos y ejecutar comandos
  private context!: GPUCanvasContext; // Contexto del canvas para presentar los frames
  private currentCommandEncoder!: GPUCommandEncoder; // Codificador de comandos actual
  private format: GPUTextureFormat = 'bgra8unorm'; // Formato de color (BGRA 8 bits por canal)

  // Dimensiones del canvas
  private static screenWidth: number = 800;
  private static screenHeight: number = 600;
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
    Render.screenWidth = width;
    Render.screenHeight = height;

    console.warn(
      `Canvas initialized: ${width}x${height} (DPR: ${dpr}, Client: ${canvas.clientWidth}x${canvas.clientHeight})`,
    );

    try {
      // 1. Obtener el adaptador WebGPU que representa el hardware gráfico
      if (!navigator.gpu) {
        throw new Error('WebGPU no está soportado en este navegador');
      }

      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        throw new Error('No se encontró un adaptador WebGPU compatible');
      }
      this.adapter = adapter;

      // 2. Crear el dispositivo lógico con las características requeridas
      this.device = await this.adapter.requestDevice({
        requiredFeatures: ['texture-compression-bc', 'depth32float-stencil8'], // Soporte para compresión de texturas
        requiredLimits: {
          maxStorageBufferBindingSize: 1024 * 1024 * 1024, // 1GB de buffer máximo
        },
      });

      // 3. Configurar el contexto del canvas para WebGPU
      const context = canvas.getContext('webgpu');
      if (!context) {
        throw new Error('No se pudo obtener el contexto WebGPU');
      }
      this.context = context;

      // Configurar el formato de color preferido
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.format,
      });

      // Observador para manejar cambios de tamaño del canvas
      this.setupResizeObserver();

      return true;
    } catch (error) {
      console.error('Error al inicializar WebGPU:', error);
      return false;
    }
  }

  // Ajustar el tamaño del buffer de render
  public async resizeBackBuffer(newWidth: number, newHeight: number): Promise<boolean> {
    if (Render.screenWidth === newWidth && Render.screenHeight === newHeight) {
      return false;
    }

    Render.screenWidth = newWidth;
    Render.screenHeight = newHeight;

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
    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const width = Math.floor(Math.max(1, this.canvas.clientWidth * dpr));
      const height = Math.floor(Math.max(1, this.canvas.clientHeight * dpr));

      this.resizeAndNotify(width, height);
    });

    observer.observe(this.canvas);
  }

  private resizeAndNotify(width: number, height: number): void {
    this.device.queue.onSubmittedWorkDone().then(() => {
      this.resizeBackBuffer(width, height);

      const [w, h] = [Render.screenWidth, Render.screenHeight];

      // Usa Render.getSize() en todos los componentes:
      const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
      const cameraComponent = mainCamera?.getComponent('camera') as CameraComponent;
      if (cameraComponent) {
        cameraComponent.getCamera().setViewport(w, h);
      }

      for (const comp of Engine.getEntities().getObjectManagerByName('tone_mapping')?.getList() ??
        []) {
        (comp as ToneMappingComponent).resize();
      }
      for (const comp of Engine.getEntities().getObjectManagerByName('antialiasing')?.getList() ??
        []) {
        (comp as AntialiasingComponent).resize();
      }

      for (const comp of Engine.getEntities().getObjectManagerByName('ambient_occlusion')?.getList() ??
        []) {
        (comp as AmbientOcclusionComponent).resize();
      }

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
    return Render.screenWidth;
  }

  public static get height(): number {
    return Render.screenHeight;
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

  public destroy(): void {}
}
