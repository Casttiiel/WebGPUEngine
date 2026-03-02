import { GPUUtils } from './utils/GPUUtils';
import { Cubemap } from '../resources/Cubemap';
import { ResourceType } from '../../types/ResourceType.enum';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { ShaderPreprocessor } from './processing/ShaderPreprocessor';

/**
 * IrradianceGenerator
 * Genera un irradiance cubemap a partir de un environment cubemap usando compute shaders
 * Implementa integración Monte Carlo sobre el hemisferio con muestreo coseno-ponderado
 */
export class IrradianceGenerator {
  private device: GPUDevice;
  private computePipeline: GPUComputePipeline | null = null;
  private computeShader: GPUShaderModule | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private sampler: GPUSampler | null = null;
  private initPromise: Promise<void> | null = null;

  // Tamaño del irradiance cubemap (típicamente 32x32 o 64x64)
  private readonly IRRADIANCE_SIZE = 128;

  constructor() {
    this.device = GPUUtils.getDevice();
  }

  /**
   * Lazily initializes the compute pipeline — only compiles GPU shaders when
   * generateIrradiance() is first called, not at engine boot.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.computePipeline) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize();
    return this.initPromise;
  }

  public async initialize(): Promise<void> {
    const t0 = performance.now();

    // Crear sampler para el cubemap de entrada
    this.sampler = this.device.createSampler({
      label: 'irradiance_input_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });

    // Cargar compute shader usando ShaderPreprocessor para procesar includes
    let tStep = performance.now();
    const shaderCode = await ShaderPreprocessor.preprocessShader(
      'utility/irradiance_convolution.wgsl',
    );
    console.log(`%c[IrradianceGenerator] preprocessShader: +${(performance.now() - tStep).toFixed(0)}ms`, 'color:#ffcc80');

    tStep = performance.now();
    this.computeShader = this.device.createShaderModule({
      label: 'irradiance_convolution_shader',
      code: shaderCode,
    });
    console.log(`%c[IrradianceGenerator] createShaderModule: +${(performance.now() - tStep).toFixed(0)}ms`, 'color:#ffcc80');

    // Crear bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'irradiance_bindgroup_layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: {
            sampleType: 'float',
            viewDimension: 'cube',
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          sampler: { type: 'filtering' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba16float',
            viewDimension: '2d-array',
          },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });

    // Crear compute pipeline — async para no bloquear el hilo principal
    const pipelineLayout = this.device.createPipelineLayout({
      label: 'irradiance_pipeline_layout',
      bindGroupLayouts: [this.bindGroupLayout],
    });

    tStep = performance.now();
    this.computePipeline = await this.device.createComputePipelineAsync({
      label: 'irradiance_compute_pipeline',
      layout: pipelineLayout,
      compute: {
        module: this.computeShader,
        entryPoint: 'main',
      },
    });
    console.log(`%c[IrradianceGenerator] createComputePipelineAsync: +${(performance.now() - tStep).toFixed(0)}ms`, 'color:#ffcc80');

    console.log(`%c[IrradianceGenerator] initialize() TOTAL: +${(performance.now() - t0).toFixed(0)}ms`, 'color:#ffcc80;font-weight:bold');
    console.log('✅ IrradianceGenerator initialized');
  }

  /**
   * Genera un irradiance cubemap a partir de un environment cubemap
   * @param inputCubemap Cubemap de entrada (environment map)
   * @returns Promise<Cubemap> Irradiance cubemap generado
   */
  public async generateIrradiance(inputCubemap: Cubemap): Promise<Cubemap> {
    await this.ensureInitialized();

    if (!this.computePipeline || !this.bindGroupLayout || !this.sampler) {
      throw new Error('IrradianceGenerator not initialized');
    }

    console.log(
      `🔶 Generating irradiance cubemap (${this.IRRADIANCE_SIZE}x${this.IRRADIANCE_SIZE})...`,
    );

    // Crear textura de salida (cubemap array con 6 capas)
    const outputTexture = this.device.createTexture({
      label: 'irradiance_output_texture',
      size: {
        width: this.IRRADIANCE_SIZE,
        height: this.IRRADIANCE_SIZE,
        depthOrArrayLayers: 6, // 6 caras del cubemap
      },
      format: 'rgba16float',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    const outputView = outputTexture.createView({
      dimension: '2d-array',
      arrayLayerCount: 6,
    });

    // Crear uniform buffer para constantes
    const uniformBuffer = this.device.createBuffer({
      label: 'irradiance_uniform_buffer',
      size: 8, // 2 x u32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Procesar cada cara del cubemap
    for (let face = 0; face < 6; face++) {
      // Actualizar uniform buffer con la cara actual
      const uniformData = new Uint32Array([face, this.IRRADIANCE_SIZE]);
      this.device.queue.writeBuffer(uniformBuffer, 0, uniformData);

      // Crear bind group para esta cara
      const bindGroup = this.device.createBindGroup({
        label: `irradiance_bindgroup_face_${face}`,
        layout: this.bindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: inputCubemap.getTextureView()!,
          },
          {
            binding: 1,
            resource: this.sampler,
          },
          {
            binding: 2,
            resource: outputView,
          },
          {
            binding: 3,
            resource: { buffer: uniformBuffer },
          },
        ],
      });

      // Ejecutar compute pass
      const commandEncoder = this.device.createCommandEncoder({
        label: `irradiance_encoder_face_${face}`,
      });

      const computePass = commandEncoder.beginComputePass({
        label: `irradiance_pass_face_${face}`,
      });

      computePass.setPipeline(this.computePipeline);
      computePass.setBindGroup(0, bindGroup);

      // Dispatch con workgroups de 8x8
      const workgroupsX = Math.ceil(this.IRRADIANCE_SIZE / 8);
      const workgroupsY = Math.ceil(this.IRRADIANCE_SIZE / 8);
      computePass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);

      computePass.end();
      this.device.queue.submit([commandEncoder.finish()]);
    }

    // Esperar a que termine la GPU
    await this.device.queue.onSubmittedWorkDone();

    console.log('✅ Irradiance cubemap generated');

    // Crear Cubemap wrapper para la textura de irradiance
    const irradianceCubemap = await this.createCubemapFromTexture(outputTexture);

    // Limpiar
    uniformBuffer.destroy();
    // No destruir outputTexture - ahora es propiedad del Cubemap

    return irradianceCubemap;
  }

  /**
   * Crea un objeto Cubemap a partir de una GPUTexture generada
   */
  private async createCubemapFromTexture(texture: GPUTexture): Promise<Cubemap> {
    // Crear un Cubemap con una textura ya generada
    // Nota: Necesitarás modificar la clase Cubemap para soportar esto
    // Por ahora, creamos un wrapper simple

    const cubemap = new Cubemap({
      path: 'generated_irradiance',
      type: ResourceType.CUBEMAP,
      label: 'generated_irradiance',
    });

    // HACK: Inyectar la textura generada directamente
    // Idealmente, Cubemap debería tener un método setTexture() o similar
    (cubemap as any).gpuTexture = texture;
    (cubemap as any).gpuTextureView = texture.createView({
      dimension: 'cube',
    });
    (cubemap as any).gpuSampler = this.device.createSampler({
      label: 'irradiance_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });

    (cubemap as any)._hasData = true;

    return cubemap;
  }

  public destroy(): void {
    // Los recursos se destruyen automáticamente
    this.computePipeline = null;
    this.computeShader = null;
    this.bindGroupLayout = null;
    this.sampler = null;
  }
}
