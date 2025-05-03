import { CameraComponent } from "../../components/render/CameraComponent";
import { Engine } from "../../core/engine/Engine";

export class Render {
  private static instance: Render;

  // Objetos principales de WebGPU
  private adapter!: GPUAdapter;           // Adaptador que representa el hardware gráfico
  private device!: GPUDevice;             // Dispositivo lógico para crear recursos y ejecutar comandos
  private context!: GPUCanvasContext;     // Contexto del canvas para presentar los frames
  private currentPass: GPURenderPassEncoder | null = null;  // Codificador del pase de render actual
  private format: GPUTextureFormat = 'bgra8unorm';         // Formato de color (BGRA 8 bits por canal)

  // Buffer global para datos de cámara
  private globalUniformBuffer: GPUBuffer | null = null;
  private globalBindGroupLayout: GPUBindGroupLayout | null = null;
  private globalBindGroup: GPUBindGroup | null = null;

  // Buffers de la pantalla
  private depthTexture: GPUTexture | null = null;          // Textura para el buffer de profundidad
  private depthView: GPUTextureView | null = null;         // Vista de la textura de profundidad
  private currentTexture: GPUTexture | null = null;        // Textura del frame actual
  private currentView: GPUTextureView | null = null;       // Vista de la textura del frame actual

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
        requiredFeatures: ['texture-compression-bc'],  // Soporte para compresión de texturas
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
          const component = entity?.getComponent("camera") as CameraComponent;
          if (!component) return;
          component.getCamera().setViewport(width, height);
        }
      });
      observer.observe(canvas);

      // Crear el buffer de profundidad inicial
      await this.createDepthBuffer();
      
      // Inicializar buffers uniformes
      this.initializeUniformBuffers();
      
      return true;

    } catch (error) {
      console.error('Error al inicializar WebGPU:', error);
      return false;
    }
  }

  private initializeUniformBuffers(): void {
    if (!this.device) return;

    // Crear buffer uniforme global para las matrices de la cámara
    this.globalUniformBuffer = this.device.createBuffer({
      label: `global uniform buffer`,
      size: 2 * 16 * 4, // 2 matrices 4x4 (view, projection)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Crear el layout para el bind group global
    this.globalBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' }
        }
      ]
    });

    // Crear el bind group global
    this.globalBindGroup = this.device.createBindGroup({
      label: `global uniform bind group`,
      layout: this.globalBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.globalUniformBuffer }
        }
      ]
    });
  }

  public updateGlobalUniforms(viewMatrix: Float32Array, projectionMatrix: Float32Array): void {
    if (!this.device || !this.globalUniformBuffer) return;

    // Escribir la matriz de vista con el nombre correcto viewMatrix
    this.device.queue.writeBuffer(
      this.globalUniformBuffer,
      0,  // viewMatrix offset
      viewMatrix.buffer
    );

    // Escribir la matriz de proyección con el nombre correcto projectionMatrix
    this.device.queue.writeBuffer(
      this.globalUniformBuffer,
      16 * 4,  // projectionMatrix offset
      projectionMatrix.buffer
    );
  }

  // Crear el buffer de profundidad con las dimensiones actuales
  private async createDepthBuffer(): Promise<void> {
    if (!this.device) return;

    // Limpiar la textura de profundidad existente si existe
    if (this.depthTexture) {
      this.depthTexture.destroy();
    }

    // Crear textura de profundidad con las dimensiones actuales del canvas
    this.depthTexture = this.device.createTexture({
      size: {
        width: Render.width,
        height: Render.height,
        depthOrArrayLayers: 1
      },
      format: 'depth24plus-stencil8',  // Formato de 24 bits para profundidad + 8 bits para stencil
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });

    this.depthView = this.depthTexture.createView();
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

      await this.createDepthBuffer();
    }

    return true;
  }

  // Comenzar un nuevo frame de renderizado
  public beginFrame(): GPUCommandEncoder | null {
    if (!this.device || !this.context) return null;

    this.currentTexture = this.context.getCurrentTexture();
    this.currentView = this.currentTexture.createView();

    return this.device.createCommandEncoder();
  }

  // Iniciar el renderizado al buffer principal
  public startRenderingBackBuffer(
    encoder: GPUCommandEncoder,
    clearColor: { r: number; g: number; b: number; a: number }
  ): boolean {
    if (!this.currentView || !this.depthView) return false;

    // Configurar el pase de renderizado con los buffers de color y profundidad
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.currentView,
        clearValue: clearColor,
        loadOp: 'clear',     // Limpiar el buffer al inicio
        storeOp: 'store'     // Guardar el resultado al final
      }],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        stencilClearValue: 0,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'store'
      }
    });

    if (!pass) {
      this.currentPass = null;
      return false;
    }

    this.currentPass = pass;
    return true;
  }

  // Finalizar y enviar los comandos de renderizado
  public endFrame(commandEncoder: GPUCommandEncoder): void {
    if (!this.device) return;

    const commandBuffer = commandEncoder.finish();
    this.device.queue.submit([commandBuffer]);
  }

  public getDevice(): GPUDevice {
    if (!this.device) {
      throw new Error('GPUDevice is not initialized');
    }
    return this.device;
  }

  public getFormat(): GPUTextureFormat {
    return this.format;
  }

  public getPass(): GPURenderPassEncoder | null {
    return this.currentPass;
  }

  public getCanvas(): HTMLCanvasElement {
    if (!this.canvas) {
      throw new Error('Canvas is not initialized');
    }
    return this.canvas;
  }

  public getGlobalBindGroupLayout(): GPUBindGroupLayout {
    if (!this.globalBindGroupLayout) {
      throw new Error('Global bind group layout is not initialized');
    }
    return this.globalBindGroupLayout;
  }

  public getGlobalBindGroup(): GPUBindGroup {
    if (!this.globalBindGroup) {
      throw new Error('Global bind group is not initialized');
    }
    return this.globalBindGroup;
  }

  public getGlobalUniformBuffer(): GPUBuffer {
    if (!this.globalUniformBuffer) {
      throw new Error('Global uniform buffer is not initialized');
    }
    return this.globalUniformBuffer;
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

  public destroy(): void {
    if (this.depthTexture) {
      this.depthTexture.destroy();
    }
  }
}
