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

/**
 * SMAA (Subpixel Morphological Anti-Aliasing) Component
 * Implements a 3-pass SMAA algorithm:
 * 1. Edge Detection - Detects edges using luma
 * 2. Blending Weight Calculation - Calculates blend weights based on edge patterns
 * 3. Neighborhood Blending - Applies final anti-aliasing
 */
export class SMAAComponent extends Component {
  private loaded = false;
  private device!: GPUDevice;

  // Techniques for the 3 passes
  private edgeTechnique!: Technique;
  private blendTechnique!: Technique;
  private neighborhoodTechnique!: Technique;

  private fullscreenQuadMesh!: Mesh;
  private renderPassManager!: RenderPassManager;

  private blendParamsBindGroup!: GPUBindGroup;

  // Render targets for intermediate results
  private edgesRT!: RenderTarget; // Edges texture (R=horizontal, G=vertical)
  private blendRT!: RenderTarget; // Blending weights texture
  private finalRT!: RenderTarget; // Final anti-aliased result

  // SMAA lookup textures
  private areaTex!: Texture; // Area texture LUT for pattern matching
  private searchTex!: Texture; // Search texture for edge length calculation

  // Uniform buffer for SMAA parameters
  private uniformBuffer!: GPUBuffer; // Pass 1 params (edge detection)
  private blendUniformBuffer!: GPUBuffer; // Pass 2 params (blending weights)

  // Bind group caches
  private edgeBindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();
  private blendBindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();
  private neighborhoodBindGroupCache: Map<string, GPUBindGroup> = new Map();

  // SMAA parameters
  private smaaParams = {
    enabled: true,
    edgeThreshold: 0.05, // Lower = more edges detected (was 0.1, reference uses 0.1, but we want stronger effect)
    predicationStrength: 2.0,
    // Pass 2 (Blending Weights) parameters
    maxSearchSteps: 16, // Higher = longer edge patterns detected (was 32)
    maxSearchStepsDiag: 4, // Higher = better diagonal detection (was 16)
    cornerRounding: 25.0,
    disableDiagDetection: false,
    useDirectWeights: false,
  };

  constructor() {
    super();
    this.renderPassManager = new RenderPassManager();
  }

  public async load(): Promise<void> {
    this.device = Render.getInstance().getDevice();
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    // Load the 3 techniques
    this.edgeTechnique = await Technique.getAsync('post-processing/smaa_edge.tech');
    this.blendTechnique = await Technique.getAsync('post-processing/smaa_blend.tech');
    this.neighborhoodTechnique = await Technique.getAsync('post-processing/smaa_neighborhood.tech');

    // Load SMAA lookup textures
    this.areaTex = await Texture.get('AreaTex.png');
    this.searchTex = await Texture.get('SearchTex.png');

    const aliasingFormat = QualitySettings.getInstance().getSettings().aliasingTexture;

    // Create uniform buffer for SMAA parameters
    this.uniformBuffer = this.device.createBuffer({
      label: 'smaa_params_uniform_buffer',
      size: 16, // 2 floats (threshold, predicationStrength) padded to 16 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Initialize with default values
    this.device.queue.writeBuffer(
      this.uniformBuffer,
      0,
      new Float32Array([this.smaaParams.edgeThreshold, this.smaaParams.predicationStrength]),
    );

    // Create uniform buffer for Pass 2 (Blending Weights) parameters
    this.blendUniformBuffer = this.device.createBuffer({
      label: 'smaa_blend_params_uniform_buffer',
      size: 32, // 5 floats: maxSearchSteps, maxSearchStepsDiag, cornerRounding, disableDiag, useDirectWeights
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Initialize blend parameters
    this.updateBlendParameters();

    // Create render targets
    this.edgesRT = new RenderTarget();
    this.edgesRT.createRT('smaa_edges.dds', Render.width, Render.height, aliasingFormat);

    this.blendRT = new RenderTarget();
    this.blendRT.createRT('smaa_blend.dds', Render.width, Render.height, aliasingFormat);

    this.finalRT = new RenderTarget();
    this.finalRT.createRT('smaa_final.dds', Render.width, Render.height, aliasingFormat);

    this.loaded = true;
  }

  public resize(): void {
    const aliasingFormat = QualitySettings.getInstance().getSettings().aliasingTexture;

    this.edgesRT.createRT('smaa_edges.dds', Render.width, Render.height, aliasingFormat);
    this.blendRT.createRT('smaa_blend.dds', Render.width, Render.height, aliasingFormat);
    this.finalRT.createRT('smaa_final.dds', Render.width, Render.height, aliasingFormat);

    // Clear all caches
    this.edgeBindGroupCache.clear();
    this.blendBindGroupCache.clear();
    this.neighborhoodBindGroupCache.clear();
  }

  /**
   * Apply SMAA to the input texture
   * Executes the 3-pass algorithm
   */
  public apply(inputTexture: GPUTextureView): GPUTextureView {
    // Update uniform buffer with current parameters
    this.device.queue.writeBuffer(
      this.uniformBuffer,
      0,
      new Float32Array([this.smaaParams.edgeThreshold, this.smaaParams.predicationStrength]),
    );

    // Update blending parameters
    this.updateBlendParameters();

    // Pass 1: Edge Detection
    const edgeBindGroup = this.getOrCreateEdgeBindGroup(inputTexture);
    this.renderPassManager.executeAntialiasingPass(
      this.fullscreenQuadMesh,
      this.edgeTechnique,
      edgeBindGroup,
      this.edgesRT,
    );

    // Pass 2: Blending Weight Calculation
    const blendBindGroup = this.getOrCreateBlendBindGroup(this.edgesRT.getView());

    // Execute blend pass manually to add params bind group
    this.executeBlendPass(blendBindGroup);

    // Pass 3: Neighborhood Blending (needs both color and blend textures)
    const neighborhoodColorBindGroup = this.getOrCreateNeighborhoodColorBindGroup(inputTexture);
    const neighborhoodBlendBindGroup = this.getOrCreateNeighborhoodBlendBindGroup(
      this.blendRT.getView(),
    );

    // Execute neighborhood pass manually since it needs 2 bind groups
    this.executeNeighborhoodPass(neighborhoodColorBindGroup, neighborhoodBlendBindGroup);

    return this.finalRT.getView();
  }

  /**
   * Execute blend pass manually (needs params bind group)
   */
  private executeBlendPass(texturesBindGroup: GPUBindGroup): void {
    const render = Render.getInstance();
    const encoder = render.getCommandEncoder();
    const paramsBindGroup = this.getBlendParamsBindGroup();

    const pass = encoder.beginRenderPass({
      label: 'SMAA Blending Weights',
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

    // Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, texturesBindGroup);
    pass.setBindGroup(2, paramsBindGroup);

    this.fullscreenQuadMesh.renderGroup(pass);
    pass.end();
  }

  /**
   * Execute neighborhood blending pass manually (needs 2 bind groups)
   */
  private executeNeighborhoodPass(
    colorBindGroup: GPUBindGroup,
    blendBindGroup: GPUBindGroup,
  ): void {
    const render = Render.getInstance();
    const encoder = render.getCommandEncoder();

    const pass = encoder.beginRenderPass({
      label: 'SMAA Neighborhood Blending',
      colorAttachments: [
        {
          view: this.finalRT.getView(), // Use getView() instead of getRenderView() - no MSAA
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    this.neighborhoodTechnique.activatePipeline(pass);
    this.fullscreenQuadMesh.activate(pass);

    // Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, colorBindGroup);
    pass.setBindGroup(2, blendBindGroup);

    this.fullscreenQuadMesh.renderGroup(pass);
    pass.end();
  }

  /**
   * Get or create bind group for color texture (neighborhood pass)
   */
  private getOrCreateNeighborhoodColorBindGroup(colorTexture: GPUTextureView): GPUBindGroup {
    let bindGroup = this.neighborhoodBindGroupCache.get(`color_${colorTexture}`);
    if (!bindGroup) {
      const sampler = SamplerLibrary.simpleSampler;

      bindGroup = BindGroupFactory.createBindGroup(
        `smaa_neighborhood_color_bindgroup`,
        this.neighborhoodTechnique.getPipeline().getBindGroupLayout(1),
        [
          {
            binding: 0,
            resource: colorTexture,
          },
          {
            binding: 1,
            resource: sampler,
          },
        ],
      );
      this.neighborhoodBindGroupCache.set(`color_${colorTexture}`, bindGroup);
    }
    return bindGroup;
  }

  /**
   * Get or create bind group for blend weights texture (neighborhood pass)
   */
  private getOrCreateNeighborhoodBlendBindGroup(blendTexture: GPUTextureView): GPUBindGroup {
    let bindGroup = this.neighborhoodBindGroupCache.get(`blend_${blendTexture}`);
    if (!bindGroup) {
      const sampler = SamplerLibrary.simpleSampler;

      bindGroup = BindGroupFactory.createBindGroup(
        `smaa_neighborhood_blend_bindgroup`,
        this.neighborhoodTechnique.getPipeline().getBindGroupLayout(2),
        [
          {
            binding: 0,
            resource: blendTexture,
          },
          {
            binding: 1,
            resource: sampler,
          },
        ],
      );
      this.neighborhoodBindGroupCache.set(`blend_${blendTexture}`, bindGroup);
    }
    return bindGroup;
  }

  /**
   * Get or create bind group for edge detection pass
   */
  private getOrCreateEdgeBindGroup(texture: GPUTextureView): GPUBindGroup {
    let bindGroup = this.edgeBindGroupCache.get(texture);
    if (!bindGroup) {
      const sampler = SamplerLibrary.simpleSampler;
      bindGroup = BindGroupFactory.createBindGroup(
        `smaa_edge_bindgroup`,
        this.edgeTechnique.getPipeline().getBindGroupLayout(1),
        [
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
            resource: {
              buffer: this.uniformBuffer,
            },
          },
        ],
      );
      this.edgeBindGroupCache.set(texture, bindGroup);
    }
    return bindGroup;
  }

  /**
   * Get or create bind group for blending weight calculation pass
   */
  private getOrCreateBlendBindGroup(edgesTexture: GPUTextureView): GPUBindGroup {
    let bindGroup = this.blendBindGroupCache.get(edgesTexture);
    if (!bindGroup) {
      const sampler = SamplerLibrary.simpleSampler;
      bindGroup = BindGroupFactory.createBindGroup(
        `smaa_blend_bindgroup`,
        this.blendTechnique.getPipeline().getBindGroupLayout(1),
        [
          {
            binding: 0,
            resource: edgesTexture,
          },
          {
            binding: 1,
            resource: sampler,
          },
          {
            binding: 2,
            resource: this.areaTex.getTextureView()!,
          },
          {
            binding: 3,
            resource: sampler, // Same sampler for areaTex
          },
          {
            binding: 4,
            resource: this.searchTex.getTextureView()!,
          },
          {
            binding: 5,
            resource: sampler, // Same sampler for searchTex
          },
        ],
      );
      this.blendBindGroupCache.set(edgesTexture, bindGroup);
    }
    return bindGroup;
  }

  public update(_dt: number): void {
    // No per-frame updates needed
  }

  private updateBlendParameters(): void {
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
  }

  /**
   * Get bind group for blending parameters (group 2)
   */
  private getBlendParamsBindGroup(): GPUBindGroup {
    if (!this.blendParamsBindGroup) {
      this.blendParamsBindGroup = BindGroupFactory.createBindGroup(
        `smaa_blend_params_bindgroup`,
        this.blendTechnique.getPipeline().getBindGroupLayout(2),
        [
          {
            binding: 0,
            resource: {
              buffer: this.blendUniformBuffer,
            },
          },
        ],
      );
    }

    return this.blendParamsBindGroup;
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();

    debugUI.addInteractiveControl('SMAA', this.smaaParams, 'enabled', 'Enabled');

    debugUI.addInteractiveControl('SMAA', this.smaaParams, 'edgeThreshold', 'Edge Threshold', {
      min: 0.01,
      max: 1.5,
      step: 0.01,
    });

    debugUI.addInteractiveControl(
      'SMAA',
      this.smaaParams,
      'predicationStrength',
      'Contrast Adaptation',
      {
        min: 0.0,
        max: 3.0,
        step: 0.1,
      },
    );

    // Pass 2 parameters
    debugUI.addInteractiveControl('SMAA', this.smaaParams, 'maxSearchSteps', 'Max Search Steps', {
      min: 4,
      max: 64,
      step: 1,
    });

    debugUI.addInteractiveControl(
      'SMAA',
      this.smaaParams,
      'maxSearchStepsDiag',
      'Max Diagonal Steps',
      {
        min: 4,
        max: 32,
        step: 1,
      },
    );

    debugUI.addInteractiveControl('SMAA', this.smaaParams, 'cornerRounding', 'Corner Rounding', {
      min: 0.0,
      max: 100.0,
      step: 5.0,
    });

    debugUI.addInteractiveControl(
      'SMAA',
      this.smaaParams,
      'disableDiagDetection',
      'Disable Diagonals',
    );

    debugUI.addInteractiveControl(
      'SMAA',
      this.smaaParams,
      'useDirectWeights',
      'Use Direct Weights',
    );
  }

  public renderDebug(): void {
    // No debug rendering needed
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }
}
