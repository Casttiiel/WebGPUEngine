import { vec4 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { CameraComponent } from './CameraComponent';
import { DirectionalLightComponent } from './DirectionalLightComponent';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { Render } from '../../renderer/core/pipeline/Render';
import { Engine } from '../../core/engine/Engine';
import { GodRaysComponentData } from '../../types/GodRaysComponentData.type';

/**
 * GodRaysComponent — Steps 1–4: Occlusion mask + Radial blur + Kawase + Composite.
 *
 * Step 1 — Occlusion mask:   quarter-res RGBA mask — geometry = black, sky/sun = white.
 * Step 2 — Radial blur:      64-sample Crytek march toward the sun NDC with decay.
 * Step 3 — Kawase blur:      5 ping-pong passes (offsets 0,1,2,2,3).
 * Step 4 — Composite:        additive blend of the blurred shafts onto the HDR frame,
 *                              tinted by the DirectionalLight sun color.
 *
 * apply() returns the same HDR texture view; the composite is done in-place
 * via pipeline additive blending (ONE+ONE, loadOp: 'load').
 *
 * GodRaysParams uniform layout (32 bytes — 8 × f32):
 *   [0] sunNdcX            — sun X in NDC [-1, 1]
 *   [1] sunNdcY            — sun Y in NDC [-1, 1]
 *   [2] occlusionThreshold — luma cutoff (sky = bright, geometry = dark)
 *   [3] enabled            — 1 = on, 0 = skip
 *   [4] intensity          — linear multiplier on radial output
 *   [5] density            — march step-length factor
 *   [6] decay              — per-step illumination falloff < 1
 *   [7] weight             — per-sample contribution weight
 */
export class GodRaysComponent extends Component {
  // ─── GPU resources ────────────────────────────────────────────────────────
  private technique!: Technique;
  private radialTechnique!: Technique;
  private kawaseTechnique!: Technique;
  private compositeTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private occlusionMask!: RenderTarget;
  private radialBlurRT!: RenderTarget;
  private kawasePingA!: RenderTarget;
  private kawasePingB!: RenderTarget;
  private renderPassManager!: RenderPassManager;
  private paramsBuffer!: GPUBuffer;
  private compositeParamsBuffer!: GPUBuffer;

  // ─── Bind group caches ────────────────────────────────────────────────────
  private paramsBindGroup: GPUBindGroup | null = null;
  private radialParamsBindGroup: GPUBindGroup | null = null;
  private compositeParamsBindGroup: GPUBindGroup | null = null;
  private defaultExposureBuffer!: GPUBuffer;
  private compositeExposureBindGroup!: GPUBindGroup;
  private trackedExposureBuffer: GPUBuffer | null = null;
  private inputBindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();
  private radialInputBindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();
  private kawaseOutputBindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();
  // Kawase: 3 pre-built input BGs [radial, pingA, pingB]; 4 offset param BGs [k=0..3]
  private kawaseInputBGs: GPUBindGroup[] = [];
  private kawaseOffsetBuffers: GPUBuffer[] = [];
  private kawaseOffsetBindGroups: GPUBindGroup[] = [];

  // ─── Tuneable parameters ───────────────────────────────────────────────────
  public isEnabled: boolean = true;
  /** Luminance threshold above which a pixel is treated as sky/sun [0, 1]. */
  public occlusionThreshold: number = 0.8;
  /** Rays intensity multiplier (Step 2). */
  public intensity: number = 1.0;
  /** Sample density along the radial march (Step 2). */
  public density: number = 0.96;
  /** Per-step light decay < 1 fades rays with distance (Step 2). */
  public decay: number = 0.97;
  /** Final accumulated-rays weight (Step 2). */
  public weight: number = 0.4;
  /** Composite-pass multiplier applied on top of intensity (Step 4). */
  public compositeScale: number = 1.0;

  private loaded = false;

  // ─── Reusable arrays to avoid hot-path allocations ────────────────────────
  private readonly paramsData = new Float32Array(8);
  private readonly compositeParamsData = new Float32Array(4);
  private readonly clipPos = vec4.create();
  private readonly sunWorld = vec4.create();

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  public async load(data?: GodRaysComponentData): Promise<void> {
    if (data) {
      if (data.enabled !== undefined) this.isEnabled = data.enabled;
      if (data.occlusionThreshold !== undefined) this.occlusionThreshold = data.occlusionThreshold;
      if (data.intensity !== undefined) this.intensity = data.intensity;
      if (data.density !== undefined) this.density = data.density;
      if (data.decay !== undefined) this.decay = data.decay;
      if (data.weight !== undefined) this.weight = data.weight;
    }

    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('post-processing/god_rays_occlusion.tech');
    this.radialTechnique = await Technique.getAsync('post-processing/god_rays_radial.tech');
    this.kawaseTechnique = await Technique.getAsync('post-processing/god_rays_kawase.tech');
    this.compositeTechnique = await Technique.getAsync('post-processing/god_rays_composite.tech');

    this.occlusionMask = new RenderTarget();
    this.occlusionMask.createRT(
      'god_rays_occlusion.dds',
      this.maskWidth(),
      this.maskHeight(),
      'rgba8unorm',
    );

    this.radialBlurRT = new RenderTarget();
    this.radialBlurRT.createRT(
      'god_rays_radial.dds',
      this.maskWidth(),
      this.maskHeight(),
      'rgba8unorm',
    );

    this.kawasePingA = new RenderTarget();
    this.kawasePingA.createRT(
      'god_rays_kawase_a.dds',
      this.maskWidth(),
      this.maskHeight(),
      'rgba8unorm',
    );

    this.kawasePingB = new RenderTarget();
    this.kawasePingB.createRT(
      'god_rays_kawase_b.dds',
      this.maskWidth(),
      this.maskHeight(),
      'rgba8unorm',
    );

    // 8 floats × 4 bytes = 32 bytes, matching GodRaysParams in WGSL
    this.paramsBuffer = GPUUtils.createBuffer(
      'god_rays_params_buffer',
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Params are at group(3) of the occlusion technique
    this.paramsBindGroup = BindGroupFactory.createBindGroup(
      'god_rays_params_bindgroup',
      this.technique.getPipeline().getBindGroupLayout(3),
      [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
    );

    // Params are at group(2) of the radial technique — same buffer, different layout
    this.radialParamsBindGroup = BindGroupFactory.createBindGroup(
      'god_rays_radial_params_bindgroup',
      this.radialTechnique.getPipeline().getBindGroupLayout(2),
      [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
    );

    // Composite params: 4 × f32 = 16 bytes { sunR, sunG, sunB, scale }.
    // Uses GodRaysUniforms layout (group 2 of composite technique).
    this.compositeParamsBuffer = GPUUtils.createBuffer(
      'god_rays_composite_params_buffer',
      16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.compositeParamsBindGroup = BindGroupFactory.createBindGroup(
      'god_rays_composite_params_bindgroup',
      this.compositeTechnique.getPipeline().getBindGroupLayout(2),
      [{ binding: 0, resource: { buffer: this.compositeParamsBuffer } }],
    );

    // Default exposure buffer (1.0) used until AutoExposureComponent provides its own.
    this.defaultExposureBuffer = GPUUtils.createBuffer(
      'god_rays_default_exposure',
      4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    GPUUtils.writeBuffer(this.defaultExposureBuffer, 0, new Float32Array([1.0]));
    this.compositeExposureBindGroup = BindGroupFactory.createBindGroup(
      'god_rays_composite_exposure_bindgroup',
      this.compositeTechnique.getPipeline().getBindGroupLayout(3),
      [{ binding: 0, resource: { buffer: this.defaultExposureBuffer } }],
    );

    // Kawase: 4 pre-written offset buffers (k = 0..3) to avoid per-frame writes inside
    // a single command encoder (writeBuffer is applied before submit, so a single buffer
    // written 5× would only see the last value for all passes).
    const kawaseParamsLayout = this.kawaseTechnique.getPipeline().getBindGroupLayout(2);
    for (let k = 0; k < 4; k++) {
      const buf = GPUUtils.createBuffer(
        `god_rays_kawase_offset_${k}`,
        16,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );
      GPUUtils.writeBuffer(buf, 0, new Float32Array([k, 0, 0, 0]));
      const bg = BindGroupFactory.createBindGroup(
        `god_rays_kawase_params_bindgroup_${k}`,
        kawaseParamsLayout,
        [{ binding: 0, resource: { buffer: buf } }],
      );
      this.kawaseOffsetBuffers.push(buf);
      this.kawaseOffsetBindGroups.push(bg);
    }

    this.rebuildKawaseInputBindGroups();

    this.renderPassManager = new RenderPassManager();
    this.loaded = true;
  }

  public resize(): void {
    if (!this.loaded) return;

    this.occlusionMask.destroy();
    this.occlusionMask = new RenderTarget();
    this.occlusionMask.createRT(
      'god_rays_occlusion.dds',
      this.maskWidth(),
      this.maskHeight(),
      'rgba8unorm',
    );

    this.radialBlurRT.destroy();
    this.radialBlurRT = new RenderTarget();
    this.radialBlurRT.createRT(
      'god_rays_radial.dds',
      this.maskWidth(),
      this.maskHeight(),
      'rgba8unorm',
    );

    this.kawasePingA.destroy();
    this.kawasePingA = new RenderTarget();
    this.kawasePingA.createRT(
      'god_rays_kawase_a.dds',
      this.maskWidth(),
      this.maskHeight(),
      'rgba8unorm',
    );

    this.kawasePingB.destroy();
    this.kawasePingB = new RenderTarget();
    this.kawasePingB.createRT(
      'god_rays_kawase_b.dds',
      this.maskWidth(),
      this.maskHeight(),
      'rgba8unorm',
    );

    // Cached bind groups reference stale texture views after resize — clear them.
    this.inputBindGroupCache.clear();
    this.radialInputBindGroupCache.clear();
    this.kawaseOutputBindGroupCache.clear();
    this.rebuildKawaseInputBindGroups();
  }

  // ─── Per-frame apply ──────────────────────────────────────────────────────

  /**
   * Run the complete god rays pipeline (Steps 1–4) and return the HDR
   * texture with the god rays additively blended in.
   *
   * Step 1 — Occlusion mask:  quarter-res RGBA mask from HDR + GBuffer depth.
   * Step 2 — Radial blur:     64-sample march toward the sun with decay.
   * Step 3 — Kawase blur:     5 ping-pong passes (offsets 0,1,2,2,3).
   * Step 4 — Composite:       additive blend of shafts onto HDR in-place.
   */
  public apply(hdrTexture: GPUTextureView, gBufferBindGroup: GPUBindGroup): GPUTextureView {
    if (!this.loaded) return hdrTexture;

    this.updateParamsBuffer();

    // ── Step 1: occlusion mask ───────────────────────────────────────────────
    const inputBindGroup = this.getOrCreateInputBindGroup(hdrTexture);
    this.renderPassManager.executeGodRaysOcclusionPass(
      this.fullscreenQuadMesh,
      this.technique,
      gBufferBindGroup,
      inputBindGroup,
      this.paramsBindGroup!,
      this.occlusionMask,
    );

    // ── Step 2: radial blur (light shafts) ───────────────────────────────────
    const radialInputBG = this.getOrCreateRadialInputBindGroup(this.occlusionMask.getView());
    this.renderPassManager.executeGodRaysRadialPass(
      this.fullscreenQuadMesh,
      this.radialTechnique,
      radialInputBG,
      this.radialParamsBindGroup!,
      this.radialBlurRT,
    );

    // ── Step 3: Kawase blur — 5 ping-pong passes ─────────────────────────────
    const PASS_INPUT_IDX = [0, 1, 2, 1, 2] as const;
    const PASS_OFFSET_IDX = [0, 1, 2, 2, 3] as const;
    const PASS_OUTPUT_RT: RenderTarget[] = [
      this.kawasePingA,
      this.kawasePingB,
      this.kawasePingA,
      this.kawasePingB,
      this.kawasePingA,
    ];

    for (let i = 0; i < 5; i++) {
      const inputIdx = PASS_INPUT_IDX[i]!;
      const offsetIdx = PASS_OFFSET_IDX[i]!;
      const outputRT = PASS_OUTPUT_RT[i]!;
      this.renderPassManager.executeGodRaysKawasePass(
        this.fullscreenQuadMesh,
        this.kawaseTechnique,
        this.kawaseInputBGs[inputIdx]!,
        this.kawaseOffsetBindGroups[offsetIdx]!,
        outputRT,
        `God Rays Kawase k=${offsetIdx}`,
      );
    }

    // ── Step 4: composite — additive blend onto HDR in-place ───────────────────
    const kawaseOutputBG = this.getOrCreateKawaseOutputBindGroup(this.kawasePingA.getView());
    this.renderPassManager.executeGodRaysCompositePass(
      this.fullscreenQuadMesh,
      this.compositeTechnique,
      hdrTexture,
      kawaseOutputBG,
      this.compositeParamsBindGroup!,
      this.compositeExposureBindGroup,
    );

    // The composite blended in-place; return the same view.
    return hdrTexture;
  }

  /** Quarter-resolution occlusion mask (Step 1 output). */
  public getOcclusionMaskView(): GPUTextureView {
    return this.occlusionMask.getView();
  }

  /** Quarter-resolution radial blur / light shafts buffer (Step 2 output). */
  public getRadialBlurView(): GPUTextureView {
    return this.radialBlurRT.getView();
  }

  /** Quarter-resolution Kawase-blurred light shafts (Step 3 output, input for Step 4). */
  public getKawaseOutputView(): GPUTextureView {
    return this.kawasePingA.getView();
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }

  public override update(_dt: number): void {}

  public override renderInMenu(): void {
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;

    if (!gui.beginWindow('God Rays', true)) return;

    const folder = (gui as any).folders?.get('God Rays');
    if (!folder) {
      gui.endWindow();
      return;
    }

    folder.add(this, 'isEnabled').name('Enable').listen();
    folder.add(this, 'occlusionThreshold', 0.0, 1.0, 0.01).name('Occlusion Threshold').listen();
    folder.add(this, 'intensity', 0.0, 5.0, 0.05).name('Intensity').listen();
    folder.add(this, 'density', 0.5, 1.0, 0.01).name('Density').listen();
    folder.add(this, 'decay', 0.8, 1.0, 0.005).name('Decay').listen();
    folder.add(this, 'weight', 0.0, 1.0, 0.01).name('Weight').listen();
    folder.add(this, 'compositeScale', 0.0, 4.0, 0.05).name('Composite Scale').listen();

    gui.endWindow();
  }

  public override renderDebug(): void {}

  public override dispose(): void {
    this.paramsBuffer?.destroy();
    this.compositeParamsBuffer?.destroy();
    this.defaultExposureBuffer?.destroy();
    this.occlusionMask?.destroy();
    this.radialBlurRT?.destroy();
    this.kawasePingA?.destroy();
    this.kawasePingB?.destroy();
    for (const buf of this.kawaseOffsetBuffers) buf?.destroy();
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Wire the GPU exposure buffer from AutoExposureComponent into the composite pass.
   * If the buffer reference is unchanged, the existing bind group is reused.
   */
  public setExposureBuffer(buf: GPUBuffer): void {
    if (buf === this.trackedExposureBuffer) return;
    this.trackedExposureBuffer = buf;
    this.compositeExposureBindGroup = BindGroupFactory.createBindGroup(
      'god_rays_composite_exposure_bindgroup',
      this.compositeTechnique.getPipeline().getBindGroupLayout(3),
      [{ binding: 0, resource: { buffer: buf } }],
    );
  }

  private maskWidth(): number {
    return Math.max(1, Render.width >> 2);
  }

  private maskHeight(): number {
    return Math.max(1, Render.height >> 2);
  }

  /** Standard cubic smoothstep — returns 0 at edge0, 1 at edge1 (reversed range supported). */
  private smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  /**
   * Write GodRaysParams into the main uniform buffer, and GodRaysCompositeParams
   * into the composite buffer (sun color from the first directional light).
   * Both buffers share the same CPU-side directional light lookup.
   */
  private updateParamsBuffer(): void {
    let sunNdcX = 0.0;
    let sunNdcY = 0.0;
    let sunR = 1.0;
    let sunG = 1.0;
    let sunB = 1.0;

    try {
      const cameraEntity = Engine.getEntities().getEntityByName('MainCamera');
      const cameraComp = cameraEntity?.getComponent('camera') as CameraComponent | null;
      const cam = cameraComp?.getCamera();

      const dirLights =
        Engine.getEntities().getObjectManagerByName('directional_light')?.getList() ?? [];

      if (cam && dirLights.length > 0) {
        const dl = dirLights[0] as DirectionalLightComponent;
        const dir = dl.getLightDirectionToSource(); // world-space direction TO the light
        const camPos = cam.getPosition();
        const vp = cam.getViewProjection();

        // Read sun color from the directional light.
        const color = dl.getColor();
        sunR = color[0] ?? 1.0;
        sunG = color[1] ?? 1.0;
        sunB = color[2] ?? 1.0;

        // Project a point far in the light direction to get sun clip-space position.
        const farDist = 1e5;
        this.sunWorld[0] = camPos[0] + dir[0] * farDist;
        this.sunWorld[1] = camPos[1] + dir[1] * farDist;
        this.sunWorld[2] = camPos[2] + dir[2] * farDist;
        this.sunWorld[3] = 1.0;

        vec4.transformMat4(this.clipPos, this.sunWorld, vp);

        // Only map to NDC when the sun is in front of the camera (w > 0).
        if (this.clipPos[3] > 0.0) {
          sunNdcX = this.clipPos[0] / this.clipPos[3];
          sunNdcY = this.clipPos[1] / this.clipPos[3];
        }
      }
    } catch {
      // If any lookup fails, use defaults.
    }

    this.paramsData[0] = sunNdcX;
    this.paramsData[1] = sunNdcY;
    this.paramsData[2] = this.occlusionThreshold;
    this.paramsData[3] = this.isEnabled ? 1.0 : 0.0;
    this.paramsData[4] = this.intensity;
    this.paramsData[5] = this.density;
    this.paramsData[6] = this.decay;
    const edgeDist = Math.max(Math.abs(sunNdcX), Math.abs(sunNdcY));
    this.paramsData[7] = this.weight * this.smoothstep(1.2, 0.8, edgeDist);
    GPUUtils.writeBuffer(this.paramsBuffer, 0, this.paramsData);

    this.compositeParamsData[0] = sunR;
    this.compositeParamsData[1] = sunG;
    this.compositeParamsData[2] = sunB;
    this.compositeParamsData[3] = this.isEnabled ? this.compositeScale : 0.0;
    GPUUtils.writeBuffer(this.compositeParamsBuffer, 0, this.compositeParamsData);
  }

  /** Get (or lazily create) the HDR input bind group for the occlusion pass.
   * HDR input is at group(2) of the occlusion technique. */
  private getOrCreateInputBindGroup(texture: GPUTextureView): GPUBindGroup {
    let bindGroup = this.inputBindGroupCache.get(texture);
    if (!bindGroup) {
      bindGroup = BindGroupFactory.createBindGroup(
        'god_rays_input_bindgroup',
        this.technique.getPipeline().getBindGroupLayout(2),
        [
          { binding: 0, resource: texture },
          { binding: 1, resource: SamplerLibrary.simpleSampler },
        ],
      );
      this.inputBindGroupCache.set(texture, bindGroup);
    }
    return bindGroup;
  }

  /** Get (or lazily create) the occlusion-mask input bind group for the radial pass.
   * Mask input is at group(1) of the radial technique (SingleTexture). */
  private getOrCreateRadialInputBindGroup(texture: GPUTextureView): GPUBindGroup {
    let bindGroup = this.radialInputBindGroupCache.get(texture);
    if (!bindGroup) {
      bindGroup = BindGroupFactory.createBindGroup(
        'god_rays_radial_input_bindgroup',
        this.radialTechnique.getPipeline().getBindGroupLayout(1),
        [
          { binding: 0, resource: texture },
          { binding: 1, resource: SamplerLibrary.simpleSampler },
        ],
      );
      this.radialInputBindGroupCache.set(texture, bindGroup);
    }
    return bindGroup;
  }

  /** Get (or lazily create) the Kawase-output bind group for the composite pass.
   * Kawase output is at group(1) of the composite technique (SingleTexture). */
  private getOrCreateKawaseOutputBindGroup(texture: GPUTextureView): GPUBindGroup {
    let bindGroup = this.kawaseOutputBindGroupCache.get(texture);
    if (!bindGroup) {
      bindGroup = BindGroupFactory.createBindGroup(
        'god_rays_kawase_output_bindgroup',
        this.compositeTechnique.getPipeline().getBindGroupLayout(1),
        [
          { binding: 0, resource: texture },
          { binding: 1, resource: SamplerLibrary.simpleSampler },
        ],
      );
      this.kawaseOutputBindGroupCache.set(texture, bindGroup);
    }
    return bindGroup;
  }

  /**
   * (Re-)build the 3 Kawase ping-pong input bind groups.
   * Must be called after the RTs are (re-)created at load and resize time.
   * Uses pre-determined texture views so there is zero per-frame allocation.
   */
  private rebuildKawaseInputBindGroups(): void {
    const layout = this.kawaseTechnique.getPipeline().getBindGroupLayout(1);
    const views = [
      this.radialBlurRT.getView(), // index 0: Step 2 output → Kawase pass 0 input
      this.kawasePingA.getView(), // index 1: Kawase pingA
      this.kawasePingB.getView(), // index 2: Kawase pingB
    ];
    this.kawaseInputBGs = views.map((view, i) =>
      BindGroupFactory.createBindGroup(`god_rays_kawase_input_${i}`, layout, [
        { binding: 0, resource: view },
        { binding: 1, resource: SamplerLibrary.simpleSampler },
      ]),
    );
  }
}
