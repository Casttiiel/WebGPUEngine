import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/Render';
import { RenderToTexture } from '../../renderer/core/RenderToTexture';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { LuminanceCalculator } from '../../renderer/core/LuminanceCalculator';

export class ToneMappingComponent extends Component {
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private bindGroup!: GPUBindGroup | null;
  private result!: RenderToTexture;
  private uniformBuffer!: GPUBuffer;
  private luminanceCalculator: LuminanceCalculator;

  // Tone mapping parameters
  private static readonly MIN_LOG_LUMINANCE = -12.0;  // Rango de luminancia logarítmica mínima
  private static readonly MAX_LOG_LUMINANCE = 4.0;    // Rango de luminancia logarítmica máxima
  private static readonly INITIAL_EXPOSURE = 0.5;     // Exposición inicial

  private currentExposure = ToneMappingComponent.INITIAL_EXPOSURE;
  private targetExposure = ToneMappingComponent.INITIAL_EXPOSURE;
  private adaptationRate = 2.0; // Velocidad de adaptación (unidades por segundo)

  constructor() {
    super();
    this.luminanceCalculator = new LuminanceCalculator();
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.technique = await Technique.get('tone_mapping.tech');
    this.result = new RenderToTexture();
    this.result.createRT('tone_mapping_result.dds', Render.width, Render.height, 'rgba16float');

    // Initialize luminance calculator
    await this.luminanceCalculator.initialize();

    // Create uniform buffer for tone mapping parameters
    const device = Render.getInstance().getDevice();
    this.uniformBuffer = device.createBuffer({
      size: 16, // minLogLuminance, maxLogLuminance, tau, exposure
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'Tone mapping uniforms',
    });

    // Initialize parameters
    this.updateUniformBuffer();
  }

  public async resize(): Promise<void> {
    this.result.createRT('tone_mapping_result.dds', Render.width, Render.height, 'rgba16float');
    this.bindGroup = null;
    await this.luminanceCalculator.resize();
  }

  public apply(texture: GPUTextureView): GPUTextureView {
    // Compute scene luminance (this doesn't read back the value, just generates it)
    this.luminanceCalculator.computeSceneLuminance(texture);

    // Set up tone mapping pass
    this.setBindGroup(texture);
    const render = Render.getInstance();
    const pass = render.getCommandEncoder().beginRenderPass({
      colorAttachments: [
        {
          view: this.result.getView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });

    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    pass.setViewport(
      0,
      0, // Offset X,Y
      render.getCanvas().width, // Width
      render.getCanvas().height, // Height
      0.0,
      1.0, // Min/max depth
    );

    pass.setScissorRect(
      0,
      0, // Offset X,Y
      render.getCanvas().width, // Width
      render.getCanvas().height, // Height
    );

    // 1. Activar el pipeline
    this.technique.activatePipeline(pass);

    // 2. Activar mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Activar bind groups
    pass.setBindGroup(0, this.bindGroup);

    // 4. Dibujar la mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();

    return this.result.getView();
  }

  private updateUniformBuffer(): void {
    const device = Render.getInstance().getDevice();
    const uniformData = new Float32Array([
      ToneMappingComponent.MIN_LOG_LUMINANCE,
      ToneMappingComponent.MAX_LOG_LUMINANCE,
      this.adaptationRate,
      this.currentExposure,
    ]);
    device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
  }

  private setBindGroup(texture: GPUTextureView): void {
    if (this.bindGroup) return;

    const device = Render.getInstance().getDevice();
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    const layout = this.technique.getPipeline().getBindGroupLayout(0);
    if (!layout) {
      throw new Error('Failed to get tone mapping technique bind group layout');
    }

    this.bindGroup = device.createBindGroup({
      label: 'tonemapping_bindgroup',
      layout,
      entries: [
        {
          binding: 0,
          resource: texture,
        },
        {
          binding: 1,
          resource: sampler,
        },
        {
          binding: 2,
          resource: this.luminanceCalculator.getAverageLuminance(),
        },
        {
          binding: 3,
          resource: { buffer: this.uniformBuffer },
        },
      ],
    });
  }

  public update(dt: number): void {
    // Obtener la luminancia promedio de la escena
    const avgLuminance = this.luminanceCalculator.getCurrentLuminance();
    if (avgLuminance !== undefined) {
      // Convertir el valor normalizado de vuelta al espacio logarítmico
      const logRange = ToneMappingComponent.MAX_LOG_LUMINANCE - ToneMappingComponent.MIN_LOG_LUMINANCE;
      const avgLogLum = avgLuminance * logRange + ToneMappingComponent.MIN_LOG_LUMINANCE;
      const lumWorld = Math.pow(2.0, avgLogLum);
      
      // Calcular exposición objetivo inversamente proporcional a la luminancia
      this.targetExposure = 0.5 / (lumWorld + 0.001);
    }

    // Interpolar suavemente la exposición actual hacia el objetivo
    if (Math.abs(this.targetExposure - this.currentExposure) > 0.001) {
      const rate = 1.0 - Math.exp(-dt * this.adaptationRate);
      this.currentExposure += (this.targetExposure - this.currentExposure) * rate;
      this.updateUniformBuffer();
    }

    // Adaptación temporal
    if (Math.abs(this.targetExposure - this.lastExposure) > 0.0001) {
      const adaptationRate = ToneMappingComponent.DEFAULT_ADAPTATION_RATE;
      const adaptationAmount = 1.0 - Math.exp(-dt * adaptationRate);
      
      this.lastExposure = this.lastExposure + (this.targetExposure - this.lastExposure) * adaptationAmount;
      
      // Actualizamos el uniform buffer con la nueva exposición
      this.updateUniformBuffer();
    }
  }

  public renderDebug(): void {
    // Not implemented yet
  }
}
