import { Component } from '../../core/ecs/Component';
import { HeightFogComponentData } from '../../types/HeightFogComponentData.type';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';

export class HeightFogComponent extends Component {
  private isLoaded = false;
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private result!: RenderTarget;
  private renderPassManager!: RenderPassManager;
  private uniformBuffer: GPUBuffer | null = null;
  private paramsBindGroup: GPUBindGroup | null = null;
  private bindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();

  // Fog parameters (private)
  private color: [number, number, number, number] = [0.7, 0.8, 0.9, 1.0];
  private density: number = 0.003;
  private scattering: number = 0.3;

  // Fog depth
  private start: number = 10.0;
  private end: number = 300.0;

  // Fog height
  private height: number = 0.0;
  private heightFalloff: number = 0.1;
  private extinction: number = 0.0;
  private noiseAmount: number = 0.1;
  private noiseScale: number = 0.01;
  private noiseSpeed: number = 0.0;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public async load(data: unknown): Promise<void> {
    const fogData = data as HeightFogComponentData;
    if (fogData.color) this.color = fogData.color;
    if (fogData.density !== undefined) this.density = fogData.density;
    if (fogData.height !== undefined) this.height = fogData.height;
    if (fogData.heightFalloff !== undefined) this.heightFalloff = fogData.heightFalloff;
    if (fogData.start !== undefined) this.start = fogData.start;
    if (fogData.end !== undefined) this.end = fogData.end;
    if (fogData.scattering !== undefined) this.scattering = fogData.scattering;

    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('height_fog.tech');

    // Uniform buffer para parámetros del fog
    const device = GPUUtils.getDevice();
    const uniformData = this.getUniformData();
    this.uniformBuffer = device.createBuffer({
      label: 'HeightFogComponent Uniforms',
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.uniformBuffer.getMappedRange()).set(uniformData);
    this.uniformBuffer.unmap();

    // Bind group para parámetros
    this.paramsBindGroup = device.createBindGroup({
      layout: this.technique.getPipeline().getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    // Render target inicial
    const fogFormat =
      QualitySettings.getInstance().getSettings().toneMappingTexture || 'rgba16float';
    this.result = new RenderTarget();
    this.result.createRT('height_fog_result.dds', Render.width, Render.height, fogFormat);

    this.isLoaded = true;
  }

  public resize(): void {
    const fogFormat =
      QualitySettings.getInstance().getSettings().toneMappingTexture || 'rgba16float';
    this.result.createRT('height_fog_result.dds', Render.width, Render.height, fogFormat);
    this.bindGroupCache.clear();
  }

  public apply(inputTexture: GPUTextureView, gBufferBindGroup?: GPUBindGroup): GPUTextureView {
    if (!this.isLoaded || !this.paramsBindGroup || !gBufferBindGroup) return inputTexture;
    let bindGroup = this.bindGroupCache.get(inputTexture);
    if (!bindGroup) {
      const sampler = SamplerLibrary.simpleSampler;
      bindGroup = BindGroupFactory.createBindGroup(
        'heightfog_bindgroup',
        this.technique.getPipeline().getBindGroupLayout(2),
        [
          {
            binding: 0,
            resource: {
              buffer: this.uniformBuffer!,
            },
          },
          { binding: 1, resource: inputTexture },
          { binding: 2, resource: sampler },
        ],
      );
      this.bindGroupCache.set(inputTexture, bindGroup);
    }
    this.renderPassManager.executeHeightFogPass(
      this.fullscreenQuadMesh,
      this.technique,
      bindGroup,
      gBufferBindGroup,
      this.result,
    );

    return this.result.getView();
  }

  private getUniformData(): Float32Array {
    return new Float32Array([
      this.color[0],
      this.color[1],
      this.color[2],
      this.color[3],
      this.density,
      this.extinction,
      this.height,
      this.heightFalloff,
      this.start,
      this.end,
      this.scattering,
      this.noiseAmount,
      this.noiseScale,
      this.noiseSpeed,
    ]);
  }

  public update(_dt: number): void {}

  public hasLoaded(): boolean {
    return this.isLoaded;
  }

  public dispose(): void {
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = null;
    }
    if (this.result) {
      this.result.destroy();
      this.result = null;
    }
    this.paramsBindGroup = null;
    this.bindGroupCache.clear();
  }

  public override renderDebug(): void {
    throw new Error('Method not implemented.');
  }
}
