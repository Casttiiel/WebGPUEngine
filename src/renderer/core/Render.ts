import { CameraComponent } from "../../components/render/CameraComponent";
import { Engine } from "../../core/engine/Engine";

export class Render {
  private static instance: Render;

  // Objetos principales de WebGPU
  private adapter!: GPUAdapter;           // Adaptador que representa el hardware gráfico
  private device!: GPUDevice;             // Dispositivo lógico para crear recursos y ejecutar comandos
  private context!: GPUCanvasContext;     // Contexto del canvas para presentar los frames
  private currentCommandEncoder!: GPUCommandEncoder; // Codificador de comandos actual
  private format: GPUTextureFormat = 'bgra8unorm';         // Formato de color (BGRA 8 bits por canal)

  // Buffers de la pantalla
  /*private depthTexture: GPUTexture | null = null;          // Textura para el buffer de profundidad
  private depthView: GPUTextureView | null = null;         // Vista de la textura de profundidad
  private currentTexture: GPUTexture | null = null;        // Textura del frame actual
  private currentView: GPUTextureView | null = null;       // Vista de la textura del frame actual
*/
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
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    Render.screenWidth = canvas.width;
    Render.screenHeight = canvas.height;

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
        requiredFeatures: ['texture-compression-bc', 'depth32float-stencil8'],  // Soporte para compresión de texturas
        requiredLimits: {
          maxStorageBufferBindingSize: 1024 * 1024 * 1024, // 1GB de buffer máximo
        }
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
      const observer = new ResizeObserver(async entries => {
        for (const entry of entries) {
          const dpr = window.devicePixelRatio || 1;
          let width = entry.contentBoxSize[0].inlineSize * dpr;
          let height = entry.contentBoxSize[0].blockSize * dpr;

          // Aplicar límites del dispositivo manteniendo el aspect ratio
          const maxDim = this.device.limits.maxTextureDimension2D;
          if (width > maxDim || height > maxDim) {
            const aspectRatio = width / height;
            if (width > height) {
              width = maxDim;
              height = width / aspectRatio;
            } else {
              height = maxDim;
              width = height * aspectRatio;
            }
          }

          width = Math.floor(Math.max(1, width));
          height = Math.floor(Math.max(1, height));
  
          await this.resizeBackBuffer(width, height);
          const entity = Engine.getEntities().getEntityByName("MainCamera");
          if(!entity) return;
          const component = entity.getComponent("camera") as CameraComponent;
          if (!component) return;
          component.getCamera().setViewport(width, height);
        }
      });
      observer.observe(canvas);
      
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

    //this.currentTexture = this.context.getCurrentTexture();
    //this.currentView = this.currentTexture.createView();

    this.currentCommandEncoder = this.device.createCommandEncoder();
  }

  // Finalizar y enviar los comandos de renderizado
  public endFrame(): void {
    if (!this.device) return;

    const commandBuffer = this.currentCommandEncoder.finish();
    this.device.queue.submit([commandBuffer]);
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

  public destroy(): void {
  }
}
