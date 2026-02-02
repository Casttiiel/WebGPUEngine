import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Render } from '../../renderer/core/pipeline/Render';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { Texture } from '../../renderer/resources/Texture';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { VelocityBufferManager } from '../../renderer/core/managers/VelocityBufferManager';

/**
 * SMAA T2x (Temporal 2x Super-Sampling Anti-Aliasing)
 * Extends SMAA 1x with:
 * - Camera jittering (2x1 or 2x2 pattern)
 * - Motion vectors (velocity buffer)
 * - Temporal accumulation (blend with previous frame)
 * - Neighborhood color clamping (reduce ghosting)
 */
export class SMAAT2xComponent extends Component {
  private loaded = false;
  private device!: GPUDevice;

  // SMAA 1x passes
  private edgeTechnique!: Technique;
  private blendTechnique!: Technique;
  private neighborhoodTechnique!: Technique;

  // Temporal resolve pass
  private temporalResolveTechnique!: Technique;

  private fullscreenQuadMesh!: Mesh;
  private renderPassManager!: RenderPassManager;

  // Render targets
  private edgesRT!: RenderTarget;
  private blendRT!: RenderTarget;
  private smaaResultRT!: RenderTarget; // SMAA 1x result (before temporal)
  private finalRT!: RenderTarget; // Final temporal result

  // Temporal accumulation
  private historyRT!: RenderTarget; // Previous frame
  // Note: Velocity buffer viene del VelocityBufferManager global

  // SMAA lookup textures
  private areaTex!: Texture;
  private searchTex!: Texture;
  private whiteTexture!: Texture; // Placeholder for unused bindings

  // Uniform buffers
  private uniformBuffer!: GPUBuffer; // SMAA edge params
  private blendUniformBuffer!: GPUBuffer; // SMAA blend params
  private temporalUniformBuffer!: GPUBuffer; // Temporal params (jitter, blend factor)

  // Bind group caches
  private edgeBindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();
  private blendBindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();
  private neighborhoodBindGroupCache: Map<string, GPUBindGroup> = new Map();
  private temporalBindGroupCache: Map<string, GPUBindGroup> = new Map();

  // Temporal state
  private frameIndex: number = 0;
  private jitterPattern: number[][] = [
    [-0.25, 0.0], // Frame 0: offset left
    [0.25, 0.0], // Frame 1: offset right
  ];
  private currentJitter: number[] = [0, 0];

  // SMAA parameters
  private smaaParams = {
    enabled: true,
    edgeThreshold: 0.05,
    predicationStrength: 2.0,
    maxSearchSteps: 64,
    maxSearchStepsDiag: 20,
    cornerRounding: 25.0,
    disableDiagDetection: false,
    useDirectWeights: false,
  };

  // Temporal parameters
  private temporalParams = {
    blendFactor: 0.1, // How much current frame vs history (0.1 = 90% history)
    neighborhoodClampFactor: 1.0, // Color clamp strength (reduce ghosting)
  };

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public async load(): Promise<void> {
    this.device = Render.getInstance().getDevice();
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    // Load SMAA 1x techniques
    this.edgeTechnique = await Technique.getAsync('post-processing/smaa_edge.tech');
    this.blendTechnique = await Technique.getAsync('post-processing/smaa_blend.tech');
    this.neighborhoodTechnique = await Technique.getAsync('post-processing/smaa_neighborhood.tech');

    // Load temporal resolve technique
    this.temporalResolveTechnique = await Technique.getAsync(
      'post-processing/smaa_temporal_resolve.tech',
    );

    // Load SMAA lookup textures
    this.areaTex = await Texture.get('AreaTex.png');
    this.searchTex = await Texture.get('SearchTex.png');
    this.whiteTexture = await Texture.get('white.png');

    const aliasingFormat = QualitySettings.getInstance().getSettings().aliasingTexture;

    // Create uniform buffers
    this.uniformBuffer = this.device.createBuffer({
      label: 'smaa_t2x_params_uniform_buffer',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.blendUniformBuffer = this.device.createBuffer({
      label: 'smaa_t2x_blend_params_uniform_buffer',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.temporalUniformBuffer = this.device.createBuffer({
      label: 'smaa_t2x_temporal_uniform_buffer',
      size: 32, // jitterOffset (vec2), blendFactor (f32), clampFactor (f32), padding
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Initialize uniform buffers
    this.updateUniformBuffers();

    // Create render targets
    this.edgesRT = new RenderTarget();
    this.edgesRT.createRT('smaa_t2x_edges.dds', Render.width, Render.height, aliasingFormat);

    this.blendRT = new RenderTarget();
    this.blendRT.createRT('smaa_t2x_blend.dds', Render.width, Render.height, aliasingFormat);

    this.smaaResultRT = new RenderTarget();
    this.smaaResultRT.createRT(
      'smaa_t2x_smaa_result.dds',
      Render.width,
      Render.height,
      aliasingFormat,
    );

    this.finalRT = new RenderTarget();
    this.finalRT.createRT(
      'smaa_t2x_final.dds',
      Render.width,
      Render.height,
      aliasingFormat,
      GPUTextureUsage.COPY_SRC, // Required for copying to history buffer
    );

    this.historyRT = new RenderTarget();
    this.historyRT.createRT(
      'smaa_t2x_history.dds',
      Render.width,
      Render.height,
      aliasingFormat,
      GPUTextureUsage.COPY_DST, // Required for receiving copy from final buffer
    );

    this.loaded = true;
  }

  private updateUniformBuffers(): void {
    // SMAA edge detection params
    this.device.queue.writeBuffer(
      this.uniformBuffer,
      0,
      new Float32Array([this.smaaParams.edgeThreshold, this.smaaParams.predicationStrength]),
    );

    // SMAA blend params
    this.device.queue.writeBuffer(
      this.blendUniformBuffer,
      0,
      new Float32Array([
        this.smaaParams.maxSearchSteps,
        this.smaaParams.maxSearchStepsDiag,
        this.smaaParams.cornerRounding,
        this.smaaParams.disableDiagDetection ? 1.0 : 0.0,
        this.smaaParams.useDirectWeights ? 1.0 : 0.0,
      ]),
    );

    // Temporal params
    this.device.queue.writeBuffer(
      this.temporalUniformBuffer,
      0,
      new Float32Array([
        this.currentJitter[0] || 0,
        this.currentJitter[1] || 0,
        this.temporalParams.blendFactor,
        this.temporalParams.neighborhoodClampFactor,
      ]),
    );
  }

  /**
   * Apply SMAA T2x to the input texture
   * Usa el velocity buffer global del VelocityBufferManager
   */
  public apply(inputTexture: GPUTextureView): GPUTextureView {
    if (!this.loaded) {
      return inputTexture;
    }

    // Update jitter pattern for this frame
    const pattern = this.jitterPattern[this.frameIndex % this.jitterPattern.length]!;
    this.currentJitter = pattern;

    // Update jitter for next frame
    this.updateUniformBuffers();

    // Pass 1: Edge Detection (with current jittered frame)
    const edgeBindGroup = this.getOrCreateEdgeBindGroup(inputTexture);
    this.renderPassManager.executeAntialiasingPass(
      this.fullscreenQuadMesh,
      this.edgeTechnique,
      edgeBindGroup,
      this.edgesRT,
    );

    // Pass 2: Blending Weight Calculation
    const blendBindGroup = this.getOrCreateBlendBindGroup(this.edgesRT.getView());
    this.executeBlendPass(blendBindGroup);

    // Pass 3: Neighborhood Blending (SMAA 1x result)
    const neighborhoodColorBindGroup = this.getOrCreateNeighborhoodColorBindGroup(inputTexture);
    const neighborhoodBlendBindGroup = this.getOrCreateNeighborhoodBlendBindGroup(
      this.blendRT.getView(),
    );
    this.executeNeighborhoodPass(neighborhoodColorBindGroup, neighborhoodBlendBindGroup);

    // Pass 4: Temporal Resolve (blend with history using velocity)
    // Obtener velocity buffer del manager global
    const velocityTexture = VelocityBufferManager.getInstance().getVelocityTextureView();
    const temporalBindGroup = this.getOrCreateTemporalBindGroup(
      this.smaaResultRT.getView(),
      this.historyRT.getView(),
      velocityTexture,
    );
    this.executeTemporalResolvePass(temporalBindGroup);

    // Copy final result to history for next frame
    this.copyToHistory();

    // Advance frame index
    this.frameIndex++;

    return this.finalRT.getView();
  }

  private executeBlendPass(texturesBindGroup: GPUBindGroup): void {
    const render = Render.getInstance();
    const encoder = render.getCommandEncoder();
    const paramsBindGroup = this.getBlendParamsBindGroup();

    const pass = encoder.beginRenderPass({
      label: 'SMAA T2x Blending Weights',
      colorAttachments: [
        {
          view: this.blendRT.getView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    this.blendTechnique.activatePipeline(pass);
    this.fullscreenQuadMesh.activate(pass);

    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, texturesBindGroup);
    pass.setBindGroup(2, paramsBindGroup);

    this.fullscreenQuadMesh.renderGroup(pass);
    pass.end();
  }

  private executeNeighborhoodPass(
    colorBindGroup: GPUBindGroup,
    blendBindGroup: GPUBindGroup,
  ): void {
    const render = Render.getInstance();
    const encoder = render.getCommandEncoder();

    const pass = encoder.beginRenderPass({
      label: 'SMAA T2x Neighborhood Blending',
      colorAttachments: [
        {
          view: this.smaaResultRT.getView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    this.neighborhoodTechnique.activatePipeline(pass);
    this.fullscreenQuadMesh.activate(pass);

    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, colorBindGroup);
    pass.setBindGroup(2, blendBindGroup);

    this.fullscreenQuadMesh.renderGroup(pass);
    pass.end();
  }

  private executeTemporalResolvePass(texturesBindGroup: GPUBindGroup): void {
    const render = Render.getInstance();
    const encoder = render.getCommandEncoder();
    const paramsBindGroup = this.getTemporalParamsBindGroup();

    const pass = encoder.beginRenderPass({
      label: 'SMAA T2x Temporal Resolve',
      colorAttachments: [
        {
          view: this.finalRT.getView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    this.temporalResolveTechnique.activatePipeline(pass);
    this.fullscreenQuadMesh.activate(pass);

    pass.setBindGroup(0, texturesBindGroup); // Textures (current, history, velocity)
    pass.setBindGroup(1, paramsBindGroup); // Temporal params

    this.fullscreenQuadMesh.renderGroup(pass);
    pass.end();
  }

  private copyToHistory(): void {
    const encoder = Render.getInstance().getCommandEncoder();

    encoder.copyTextureToTexture(
      { texture: this.finalRT.getTexture() },
      { texture: this.historyRT.getTexture() },
      {
        width: this.finalRT.getWidth(),
        height: this.finalRT.getHeight(),
        depthOrArrayLayers: 1,
      },
    );
  }

  // Bind group creation methods (similar to SMAAComponent)
  private getOrCreateEdgeBindGroup(inputTexture: GPUTextureView): GPUBindGroup {
    if (this.edgeBindGroupCache.has(inputTexture)) {
      return this.edgeBindGroupCache.get(inputTexture)!;
    }

    const bindGroup = BindGroupFactory.createBindGroup(
      `smaa_t2x_edge_bindgroup`,
      this.edgeTechnique.getPipeline().getBindGroupLayout(1)!,
      [
        { binding: 0, resource: inputTexture },
        { binding: 1, resource: SamplerLibrary.simpleSampler },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    );

    this.edgeBindGroupCache.set(inputTexture, bindGroup);
    return bindGroup;
  }

  private getOrCreateBlendBindGroup(edgesTexture: GPUTextureView): GPUBindGroup {
    if (this.blendBindGroupCache.has(edgesTexture)) {
      return this.blendBindGroupCache.get(edgesTexture)!;
    }

    const bindGroup = BindGroupFactory.createBindGroup(
      `smaa_t2x_blend_bindgroup`,
      this.blendTechnique.getPipeline().getBindGroupLayout(1)!,
      [
        { binding: 0, resource: edgesTexture },
        { binding: 1, resource: SamplerLibrary.simpleSampler },
        { binding: 2, resource: this.areaTex.getTextureView()! },
        { binding: 3, resource: SamplerLibrary.simpleSampler },
        { binding: 4, resource: this.searchTex.getTextureView()! },
        { binding: 5, resource: SamplerLibrary.simpleSampler },
      ],
    );

    this.blendBindGroupCache.set(edgesTexture, bindGroup);
    return bindGroup;
  }

  private getBlendParamsBindGroup(): GPUBindGroup {
    return BindGroupFactory.createBindGroup(
      `smaa_t2x_blend_params_bindgroup`,
      this.blendTechnique.getPipeline().getBindGroupLayout(2)!,
      [{ binding: 0, resource: { buffer: this.blendUniformBuffer } }],
    );
  }

  private getOrCreateNeighborhoodColorBindGroup(colorTexture: GPUTextureView): GPUBindGroup {
    const key = `color_${colorTexture}`;
    if (this.neighborhoodBindGroupCache.has(key)) {
      return this.neighborhoodBindGroupCache.get(key)!;
    }

    const bindGroup = BindGroupFactory.createBindGroup(
      `smaa_t2x_neighborhood_color_bindgroup`,
      this.neighborhoodTechnique.getPipeline().getBindGroupLayout(1)!,
      [
        { binding: 0, resource: colorTexture },
        { binding: 1, resource: SamplerLibrary.simpleSampler },
      ],
    );

    this.neighborhoodBindGroupCache.set(key, bindGroup);
    return bindGroup;
  }

  private getOrCreateNeighborhoodBlendBindGroup(blendTexture: GPUTextureView): GPUBindGroup {
    const key = `blend_${blendTexture}`;
    if (this.neighborhoodBindGroupCache.has(key)) {
      return this.neighborhoodBindGroupCache.get(key)!;
    }

    const bindGroup = BindGroupFactory.createBindGroup(
      `smaa_t2x_neighborhood_blend_bindgroup`,
      this.neighborhoodTechnique.getPipeline().getBindGroupLayout(2)!,
      [
        { binding: 0, resource: blendTexture },
        { binding: 1, resource: SamplerLibrary.simpleSampler },
      ],
    );

    this.neighborhoodBindGroupCache.set(key, bindGroup);
    return bindGroup;
  }

  private getOrCreateTemporalBindGroup(
    currentTexture: GPUTextureView,
    historyTexture: GPUTextureView,
    velocityTexture: GPUTextureView,
  ): GPUBindGroup {
    const key = `temporal_${currentTexture}_${historyTexture}`;
    if (this.temporalBindGroupCache.has(key)) {
      return this.temporalBindGroupCache.get(key)!;
    }

    // @group(0) = FourTexture layout (sampler at 0, textures at 1-4)
    const texturesBindGroup = BindGroupFactory.createBindGroup(
      `smaa_t2x_temporal_textures_bindgroup`,
      this.temporalResolveTechnique.getPipeline()!.getBindGroupLayout(0),
      [
        { binding: 0, resource: SamplerLibrary.simpleSampler },
        { binding: 1, resource: currentTexture },
        { binding: 2, resource: historyTexture },
        { binding: 3, resource: velocityTexture },
        { binding: 4, resource: this.whiteTexture.getTextureView()! }, // Unused placeholder
      ],
    );

    this.temporalBindGroupCache.set(key, texturesBindGroup);
    return texturesBindGroup;
  }

  private getTemporalParamsBindGroup(): GPUBindGroup {
    // @group(1) = temporal params buffer
    return BindGroupFactory.createBindGroup(
      `smaa_t2x_temporal_params_bindgroup`,
      this.temporalResolveTechnique.getPipeline()!.getBindGroupLayout(1),
      [{ binding: 0, resource: { buffer: this.temporalUniformBuffer } }],
    );
  }

  public resize(): void {
    const aliasingFormat = QualitySettings.getInstance().getSettings().aliasingTexture;

    this.edgesRT.createRT('smaa_t2x_edges.dds', Render.width, Render.height, aliasingFormat);
    this.blendRT.createRT('smaa_t2x_blend.dds', Render.width, Render.height, aliasingFormat);
    this.smaaResultRT.createRT(
      'smaa_t2x_smaa_result.dds',
      Render.width,
      Render.height,
      aliasingFormat,
    );
    this.finalRT.createRT(
      'smaa_t2x_final.dds',
      Render.width,
      Render.height,
      aliasingFormat,
      GPUTextureUsage.COPY_SRC, // Required for copying to history buffer
    );
    this.historyRT.createRT(
      'smaa_t2x_history.dds',
      Render.width,
      Render.height,
      aliasingFormat,
      GPUTextureUsage.COPY_DST, // Required for receiving copy from final buffer
    );
    // Velocity buffer gestionado por VelocityBufferManager

    // Clear all caches
    this.edgeBindGroupCache.clear();
    this.blendBindGroupCache.clear();
    this.neighborhoodBindGroupCache.clear();
    this.temporalBindGroupCache.clear();
  }

  public update(_dt: number): void {
    // Update camera jitter for next frame
    // (will be applied before rendering)
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const folder = 'SMAA T2x';

    debugUI.addInteractiveControl(folder, this.smaaParams, 'enabled', 'Enabled');
    debugUI.addInteractiveControl(folder, this.smaaParams, 'edgeThreshold', 'Edge Threshold', {
      min: 0.0,
      max: 0.5,
      step: 0.01,
    });
    debugUI.addInteractiveControl(folder, this.temporalParams, 'blendFactor', 'Blend Factor', {
      min: 0.0,
      max: 1.0,
      step: 0.05,
    });
    debugUI.addInteractiveControl(
      folder,
      this.temporalParams,
      'neighborhoodClampFactor',
      'Clamp Factor',
      { min: 0.0, max: 2.0, step: 0.1 },
    );
  }

  public renderDebug(): void {
    // Debug rendering if needed
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }
}
