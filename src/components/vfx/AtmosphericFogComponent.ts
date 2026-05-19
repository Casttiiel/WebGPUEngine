import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
import { AtmosphericFogComponentData } from '../../types/AtmosphericFogComponentData.type';
import { Engine } from '../../core/engine/Engine';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { ProceduralSkyCubemap } from '../../renderer/shading/ProceduralSkyCubemap';

// Uniform buffer layout (128 bytes, 8 vec4):
//   [0..3]   fogColor.rgb + fogDensity
//   [4..7]   fogHeightStart, fogHeightEnd, fogFalloff, pad
//   [8..11]  distanceFogStart, distanceFogEnd, distanceExponent, pad
//   [12..15] nearFogColor.rgb + pad
//   [16..19] nearFogStart, nearFogEnd, pad, pad
//   [20..23] mipFogStart, mipFogEnd, mipFogMaxMip, mipFogStrength
//   [24..27] globalAmbientBoost, pad, pad, pad
//   [28..31] reserved / padding (16 bytes)
const UNIFORM_SIZE = 128;
const UNIFORM_FLOATS = UNIFORM_SIZE / 4;

export class AtmosphericFogComponent extends Component {
  private isLoaded = false;
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private result!: RenderTarget;
  private renderPassManager!: RenderPassManager;
  private uniformBuffer: GPUBuffer | null = null;
  private uniformData: Float32Array = new Float32Array(UNIFORM_FLOATS);

  // Bind group cache: keyed by input texture view (changes when upscaling or pipeline changes)
  private bindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();
  // Track which sky cubemap instance was used to build the cache so we can invalidate
  // when it transitions from null → loaded (or changes for any other reason).
  private cachedSkyCubemap: ProceduralSkyCubemap | null | undefined = undefined;

  // Fog parameters — set from component data
  private fogColor: [number, number, number] = [0.65, 0.72, 0.85];
  public fogDensity: number = 0.8;
  public fogHeightStart: number = 10.0;
  public fogHeightEnd: number = -20.0;
  public fogFalloff: number = 1.5;
  public distanceFogStart: number = 50.0;
  public distanceFogEnd: number = 400.0;
  public distanceExponent: number = 1.0;
  private nearFogColor: [number, number, number] = [0.75, 0.82, 0.92];
  private nearFogStart: number = 0.0;
  private nearFogEnd: number = 5.0;
  public mipFogStart: number = 150.0;
  public mipFogEnd: number = 350.0;
  public mipFogMaxMip: number = 5.0;
  public mipFogStrength: number = 0.95;
  public globalAmbientBoost: number = 1.0;

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public async load(data: AtmosphericFogComponentData): Promise<void> {
    const d = data;

    if (d.fogColor) this.fogColor = d.fogColor;
    if (d.fogDensity !== undefined) this.fogDensity = d.fogDensity;
    if (d.fogHeightStart !== undefined) this.fogHeightStart = d.fogHeightStart;
    if (d.fogHeightEnd !== undefined) this.fogHeightEnd = d.fogHeightEnd;
    if (d.fogFalloff !== undefined) this.fogFalloff = d.fogFalloff;
    if (d.distanceFogStart !== undefined) this.distanceFogStart = d.distanceFogStart;
    if (d.distanceFogEnd !== undefined) this.distanceFogEnd = d.distanceFogEnd;
    if (d.distanceExponent !== undefined) this.distanceExponent = d.distanceExponent;
    if (d.nearFogColor) this.nearFogColor = d.nearFogColor;
    if (d.nearFogStart !== undefined) this.nearFogStart = d.nearFogStart;
    if (d.nearFogEnd !== undefined) this.nearFogEnd = d.nearFogEnd;
    if (d.mipFogStart !== undefined) this.mipFogStart = d.mipFogStart;
    if (d.mipFogEnd !== undefined) this.mipFogEnd = d.mipFogEnd;
    if (d.mipFogMaxMip !== undefined) this.mipFogMaxMip = d.mipFogMaxMip;
    if (d.mipFogStrength !== undefined) this.mipFogStrength = d.mipFogStrength;
    if (d.globalAmbientBoost !== undefined) this.globalAmbientBoost = d.globalAmbientBoost;

    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('post-processing/atmospheric_fog.tech');

    const device = GPUUtils.getDevice();
    this.buildUniformData();
    this.uniformBuffer = device.createBuffer({
      label: 'AtmosphericFogComponent Uniforms',
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.uniformBuffer.getMappedRange()).set(this.uniformData);
    this.uniformBuffer.unmap();

    const fogFormat =
      QualitySettings.getInstance().getSettings().toneMappingTexture ?? 'rgba16float';
    this.result = new RenderTarget();
    this.result.createRT('atmospheric_fog_result.dds', Render.width, Render.height, fogFormat);

    this.isLoaded = true;
  }

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'atmospheric_fog', (comp) => {
      const c = comp as AtmosphericFogComponent;
      if (c.hasLoaded()) c.resize();
    });
  }

  public resize(): void {
    const fogFormat =
      QualitySettings.getInstance().getSettings().toneMappingTexture ?? 'rgba16float';
    this.result.createRT('atmospheric_fog_result.dds', Render.width, Render.height, fogFormat);
    this.bindGroupCache.clear();
  }

  private uniformsDirty = false;

  public apply(inputTexture: GPUTextureView, gBufferBindGroup?: GPUBindGroup): GPUTextureView {
    if (!this.isLoaded || !this.uniformBuffer || !gBufferBindGroup) return inputTexture;

    if (this.uniformsDirty) {
      this.buildUniformData();
      GPUUtils.writeBuffer(this.uniformBuffer, 0, this.uniformData);
      this.uniformsDirty = false;
    }

    // Resolve environment source: live procedural sky cubemap when available,
    // otherwise fall back to the baked SSR environment cubemap.
    const deferred = Engine.getRender().getDeferredRenderer();
    const skyCubemap: ProceduralSkyCubemap | null = deferred.getProceduralSkyCubemap();

    // If the available sky cubemap changed (e.g. null → loaded), the cached bind groups
    // reference the wrong texture — clear and rebuild.
    if (skyCubemap !== this.cachedSkyCubemap) {
      this.bindGroupCache.clear();
      this.cachedSkyCubemap = skyCubemap;
    }

    let bindGroup = this.bindGroupCache.get(inputTexture);
    if (!bindGroup) {
      const ssrEnv = Engine.getEnvironmentManager().getSSREnvironmentTexture();
      const envView = skyCubemap ? skyCubemap.getCubemapView() : ssrEnv.getTextureView()!;
      const envSampler = skyCubemap ? skyCubemap.getSampler() : ssrEnv.getSampler()!;
      bindGroup = BindGroupFactory.createBindGroup(
        'atmospheric_fog_bindgroup',
        this.technique.getPipeline().getBindGroupLayout(2),
        [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: inputTexture },
          { binding: 2, resource: SamplerLibrary.simpleSampler },
          { binding: 3, resource: envView },
          { binding: 4, resource: envSampler },
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

  public update(_dt: number): void {}

  public hasLoaded(): boolean {
    return this.isLoaded;
  }

  /** Invalidate bind group cache when the environment cubemap changes at runtime. */
  public invalidateBindGroupCache(): void {
    this.bindGroupCache.clear();
  }

  private buildUniformData(): void {
    const d = this.uniformData;
    // fogColor.rgb + density
    d[0] = this.fogColor[0];
    d[1] = this.fogColor[1];
    d[2] = this.fogColor[2];
    d[3] = this.fogDensity;
    // fogHeight
    d[4] = this.fogHeightStart;
    d[5] = this.fogHeightEnd;
    d[6] = this.fogFalloff;
    d[7] = 0;
    // distanceFog
    d[8] = this.distanceFogStart;
    d[9] = this.distanceFogEnd;
    d[10] = this.distanceExponent;
    d[11] = 0;
    // nearFogColor
    d[12] = this.nearFogColor[0];
    d[13] = this.nearFogColor[1];
    d[14] = this.nearFogColor[2];
    d[15] = 0;
    // nearFogRange
    d[16] = this.nearFogStart;
    d[17] = this.nearFogEnd;
    d[18] = 0;
    d[19] = 0;
    // mipFog
    d[20] = this.mipFogStart;
    d[21] = this.mipFogEnd;
    d[22] = this.mipFogMaxMip;
    d[23] = this.mipFogStrength;
    // globalBoost
    d[24] = this.globalAmbientBoost;
    d[25] = 0;
    d[26] = 0;
    d[27] = 0;
  }

  public override dispose(): void {
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = null;
    }
    if (this.result) {
      this.result.destroy();
      (this.result as unknown) = null;
    }
    this.bindGroupCache.clear();
    this.isLoaded = false;
  }

  public override renderDebug(): void {}

  private _editorFolder: any = null;

  public override renderInMenu(folder?: any): void {
    if (!folder) return;
    if (this._editorFolder) return;
    this._editorFolder = folder.addFolder('Atmospheric Fog');
    this._editorFolder.close();

    const dirty = () => {
      this.uniformsDirty = true;
    };

    // Distance
    this._editorFolder
      .add(this, 'distanceFogStart', 0, 2000)
      .name('Fog Start')
      .listen()
      .onChange(dirty);
    this._editorFolder
      .add(this, 'distanceFogEnd', 0, 5000)
      .name('Fog End')
      .listen()
      .onChange(dirty);
    this._editorFolder.add(this, 'fogDensity', 0, 1).name('Fog Density').listen().onChange(dirty);
    this._editorFolder
      .add(this, 'distanceExponent', 0.1, 4)
      .name('Distance Exponent')
      .listen()
      .onChange(dirty);

    // Height
    this._editorFolder
      .add(this, 'fogHeightStart', -200, 200)
      .name('Height Start')
      .listen()
      .onChange(dirty);
    this._editorFolder
      .add(this, 'fogHeightEnd', -200, 200)
      .name('Height End')
      .listen()
      .onChange(dirty);
    this._editorFolder
      .add(this, 'fogFalloff', 0.1, 10)
      .name('Height Falloff')
      .listen()
      .onChange(dirty);

    // MIP fog
    this._editorFolder
      .add(this, 'mipFogStart', 0, 3000)
      .name('MIP Fog Start')
      .listen()
      .onChange(dirty);
    this._editorFolder.add(this, 'mipFogEnd', 0, 5000).name('MIP Fog End').listen().onChange(dirty);
    this._editorFolder
      .add(this, 'mipFogMaxMip', 0, 8)
      .name('MIP Max Level')
      .listen()
      .onChange(dirty);
    this._editorFolder
      .add(this, 'mipFogStrength', 0, 1)
      .name('MIP Fog Strength')
      .listen()
      .onChange(dirty);

    // Global boost
    this._editorFolder
      .add(this, 'globalAmbientBoost', 0, 4)
      .name('Env Boost')
      .listen()
      .onChange(dirty);
  }
}
