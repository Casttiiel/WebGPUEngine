export class Render {
    private static instance: Render;
    
    // WebGPU core objects
    private adapter!: GPUAdapter;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private currentPass: GPURenderPassEncoder | null = null;
    private format: GPUTextureFormat = 'bgra8unorm';
    
    // Screen buffers
    private depthTexture: GPUTexture | null = null;
    private depthView: GPUTextureView | null = null;
    private currentTexture: GPUTexture | null = null;
    private currentView: GPUTextureView | null = null;
  
    // Canvas dimensions
    private static screenWidth: number = 800;
    private static screenHeight: number = 600;
    private canvas!: HTMLCanvasElement;
  
    private constructor() {
      // Private constructor for singleton pattern
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
  
    public async initialize(canvas: HTMLCanvasElement): Promise<boolean> {
      if(!canvas) {
        console.error('Canvas element is null or undefined');
        return false;
      }
      this.canvas = canvas;
      
      // Set initial canvas size to match client dimensions
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      Render.screenWidth = canvas.width;
      Render.screenHeight = canvas.height;
  
      try {
        // 1. Get WebGPU adapter
        if (!navigator.gpu) {
          throw new Error('WebGPU not supported');
        }
  
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          throw new Error('No appropriate GPUAdapter found');
        }
        this.adapter = adapter;
  
        // 2. Get WebGPU device
        this.device = await this.adapter.requestDevice({
          requiredFeatures: ['texture-compression-bc'],
          requiredLimits: {
            maxStorageBufferBindingSize: 1024 * 1024 * 1024, // 1GB
          }
        });
  
        // 3. Configure canvas context
        const context = canvas.getContext('webgpu');
        if (!context) {
          throw new Error('Failed to get WebGPU context');
        }
        this.context = context;
  
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
          device: this.device,
          format: this.format,
        });
  
        await this.createDepthBuffer();
        return true;
  
      } catch (error) {
        console.error('Failed to initialize WebGPU:', error);
        return false;
      }
    }
  
    private async createDepthBuffer(): Promise<void> {
      if (!this.device) return;
  
      // Clean up existing depth texture if it exists
      if (this.depthTexture) {
        this.depthTexture.destroy();
      }
  
      // Create depth texture with current canvas dimensions
      this.depthTexture = this.device.createTexture({
        size: {
          width: this.canvas.width || Render.screenWidth,
          height: this.canvas.height || Render.screenHeight,
          depthOrArrayLayers: 1
        },
        format: 'depth24plus-stencil8',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      });
  
      this.depthView = this.depthTexture.createView();
    }
  
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
  
      if (this.context && this.device) {
        this.context.configure({
          device: this.device,
          format: this.format,
          alphaMode: 'premultiplied'
        });
  
        await this.createDepthBuffer();
      }
  
      return true;
    }
  
    public beginFrame(): GPUCommandEncoder | null {
      if (!this.device || !this.context) return null;
  
      this.currentTexture = this.context.getCurrentTexture();
      this.currentView = this.currentTexture.createView();
  
      return this.device.createCommandEncoder();
    }
  
    public startRenderingBackBuffer(
      encoder: GPUCommandEncoder,
      clearColor: { r: number; g: number; b: number; a: number }
    ): boolean {
      if (!this.currentView || !this.depthView) return false;
  
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.currentView,
          clearValue: clearColor,
          loadOp: 'clear',
          storeOp: 'store'
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

      if(!pass) {
        this.currentPass = null;
        return false;
      }

      this.currentPass = pass;
      return true;
    }
  
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
  
    public destroy(): void {
      if (this.depthTexture) {
        this.depthTexture.destroy();
      }
    }
  }
