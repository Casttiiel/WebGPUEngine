import { Component } from '../../core/ecs/Component';
import { MsgDispatcher } from '../../core/ecs/MsgDispatcher';
import { MsgType } from '../../types/MsgType.enum';
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
 * GodRaysComponent — Volumetric god rays via per-pixel shadow-map raymarch.
 *
 * Unlike the legacy screen-space Crytek approach, this implementation marches
 * along each pixel's world-space view ray and samples the CSM shadow maps at
 * every step, accumulating in-scattered directional light.  The result is
 * physically-based light shafts that are visible from ANY camera angle, not
 * just when looking toward the sun.
 *
 * Pipeline (3 steps):
 *   Step 1 — Volumetric march: per-pixel CSM shadow sampling at quarter-res.
 *   Step 2 — Kawase blur:      5 ping-pong passes to smooth the noisy output.
 *   Step 3 — Composite:        additive blend of blurred shafts onto HDR frame,
 *                               tinted by the DirectionalLight sun colour.
 *
 * VolumetricGodRaysParams layout (32 bytes — 8 × f32):
 *   [0] density     — σs: scattering coefficient (in-scatter strength)
 *   [1] extinction  — σt: extinction = σs + σa (opacity per world unit)
 *   [2] intensity   — final brightness multiplier
 *   [3] enabled     — 0 = skip pass, 1 = compute shafts
 *   [4] stepCount   — number of raymarch steps (stored as f32)
 *   [5–7]           — padding
 */
export class GodRaysComponent extends Component {
  // ─── GPU resources ────────────────────────────────────────────────────────
  private volumetricTechnique!: Technique;
  private kawaseTechnique!: Technique;
  private compositeTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private volumetricRT!: RenderTarget;
  private kawasePingA!: RenderTarget;
  private kawasePingB!: RenderTarget;
  private renderPassManager!: RenderPassManager;
  private paramsBuffer!: GPUBuffer;
  private compositeParamsBuffer!: GPUBuffer;

  // ─── Bind group caches ────────────────────────────────────────────────────
  private volumetricParamsBindGroup: GPUBindGroup | null = null;
  private compositeParamsBindGroup: GPUBindGroup | null = null;
  private defaultExposureBuffer!: GPUBuffer;
  private compositeExposureBindGroup!: GPUBindGroup;
  private trackedExposureBuffer: GPUBuffer | null = null;

  // CSM bind group for the volumetric pass — rebuilt when shadow view changes.
  private csmBindGroup: GPUBindGroup | null = null;
  private cachedShadowView0: GPUTextureView | null = null;

  private kawaseOutputBindGroupCache: Map<GPUTextureView, GPUBindGroup> = new Map();
  // Kawase: 3 pre-built input BGs [volumetric, pingA, pingB]; 4 offset param BGs [k=0..3]
  private kawaseInputBGs: GPUBindGroup[] = [];
  private kawaseOffsetBuffers: GPUBuffer[] = [];
  private kawaseOffsetBindGroups: GPUBindGroup[] = [];

  // ─── Tuneable parameters ───────────────────────────────────────────────────
  public isEnabled: boolean = true;
  /** Scattering coefficient σs — controls how strongly particles scatter light. */
  public density: number = 0.3;
  /** Extinction coefficient σt (≥ density) — higher = more opaque atmosphere. */
  public extinction: number = 0.35;
  /** Number of raymarch steps. More = less banding, more cost. */
  public numSteps: number = 32;
  /** Linear brightness multiplier applied to the accumulated volumetric light. */
  public intensity: number = 1.0;
  /** Composite-pass scale applied on top of intensity (Step 3). */
  public compositeScale: number = 1.0;

  private loaded = false;

  // ─── Reusable arrays to avoid hot-path allocations ────────────────────────
  private readonly paramsData = new Float32Array(8);
  private readonly compositeParamsData = new Float32Array(4);

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  public async load(data?: GodRaysComponentData): Promise<void> {
    if (data) {
      if (data.enabled !== undefined) this.isEnabled = data.enabled;
      if (data.density !== undefined) this.density = data.density;
      if (data.extinction !== undefined) this.extinction = data.extinction;
      if (data.numSteps !== undefined) this.numSteps = data.numSteps;
      if (data.intensity !== undefined) this.intensity = data.intensity;
      if (data.compositeScale !== undefined) this.compositeScale = data.compositeScale;
    }

    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.volumetricTechnique = await Technique.getAsync('post-processing/god_rays_volumetric.tech');
    this.kawaseTechnique = await Technique.getAsync('post-processing/god_rays_kawase.tech');
    this.compositeTechnique = await Technique.getAsync('post-processing/god_rays_composite.tech');

    this.volumetricRT = new RenderTarget();
    this.volumetricRT.createRT(
      'god_rays_volumetric.dds',
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

    // 8 floats × 4 bytes = 32 bytes, matching VolumetricGodRaysParams in WGSL.
    this.paramsBuffer = GPUUtils.createBuffer(
      'god_rays_params_buffer',
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Volumetric params are at group(3) of the volumetric technique.
    this.volumetricParamsBindGroup = BindGroupFactory.createBindGroup(
      'god_rays_params_bindgroup',
      this.volumetricTechnique.getPipeline().getBindGroupLayout(3),
      [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
    );

    // Composite params: 4 × f32 = 16 bytes { sunR, sunG, sunB, scale }.
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

  public static registerMsgs(): void {
    MsgDispatcher.register(MsgType.RESIZE, 'god_rays', (comp) => {
      const c = comp as GodRaysComponent;
      if (c.hasLoaded()) c.resize();
    });
  }

  public resize(): void {
    if (!this.loaded) return;

    this.volumetricRT.destroy();
    this.volumetricRT = new RenderTarget();
    this.volumetricRT.createRT(
      'god_rays_volumetric.dds',
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
    this.csmBindGroup = null;
    this.cachedShadowView0 = null;
    this.kawaseOutputBindGroupCache.clear();
    this.rebuildKawaseInputBindGroups();
  }

  // ─── Per-frame apply ──────────────────────────────────────────────────────

  /**
   * Run the complete volumetric god rays pipeline (Steps 1–3) and return the
   * same HDR texture with god rays additively blended in.
   *
   * Step 1 — Volumetric march:  per-pixel CSM shadow sampling at quarter-res.
   * Step 2 — Kawase blur:       5 ping-pong passes (offsets 0,1,2,2,3).
   * Step 3 — Composite:         additive blend of shafts onto HDR in-place.
   *
   * Returns unmodified hdrTexture if no valid directional light with shadows
   * is found in the scene.
   */
  public apply(hdrTexture: GPUTextureView, gBufferBindGroup: GPUBindGroup): GPUTextureView {
    if (!this.loaded) return hdrTexture;

    this.updateParamsBuffer();

    // CSM bind group — requires a directional light with shadow maps.
    const csmBG = this.getOrCreateCSMBindGroup();
    if (!csmBG) return hdrTexture;

    // ── Step 1: volumetric light scatter ─────────────────────────────────────
    this.renderPassManager.executeGodRaysVolumetricPass(
      this.fullscreenQuadMesh,
      this.volumetricTechnique,
      gBufferBindGroup,
      csmBG,
      this.volumetricParamsBindGroup!,
      this.volumetricRT,
    );

    // ── Step 2: Kawase blur — 5 ping-pong passes ─────────────────────────────
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

    // ── Step 3: composite — additive blend onto HDR in-place ──────────────────
    const kawaseOutputBG = this.getOrCreateKawaseOutputBindGroup(this.kawasePingA.getView());
    this.renderPassManager.executeGodRaysCompositePass(
      this.fullscreenQuadMesh,
      this.compositeTechnique,
      hdrTexture,
      kawaseOutputBG,
      this.compositeParamsBindGroup!,
      this.compositeExposureBindGroup,
    );

    return hdrTexture;
  }

  /** Quarter-resolution volumetric scatter buffer (Step 1 output). */
  public getVolumetricView(): GPUTextureView {
    return this.volumetricRT.getView();
  }

  /** Quarter-resolution Kawase-blurred light shafts (Step 2 output, input for Step 3). */
  public getKawaseOutputView(): GPUTextureView {
    return this.kawasePingA.getView();
  }

  public hasLoaded(): boolean {
    return this.loaded;
  }

  public override update(_dt: number): void {}


  public override renderInMenu(folder?: any): void {
    if (!folder) return;
    if (this._editorFolder) return;
    this._editorFolder = folder.addFolder('Volumetric Scattering');
    this._editorFolder.close();
    this._editorFolder.add(this, 'isEnabled').name('Enable').listen();
    this._editorFolder.add(this, 'density', 0.0, 2.0, 0.01).name('Density (σs)').listen();
    this._editorFolder.add(this, 'extinction', 0.0, 2.0, 0.01).name('Extinction (σt)').listen();
    this._editorFolder.add(this, 'numSteps', 8, 64, 1).name('Steps').listen();
    this._editorFolder.add(this, 'intensity', 0.0, 5.0, 0.05).name('Intensity').listen();
    this._editorFolder.add(this, 'compositeScale', 0.0, 4.0, 0.05).name('Composite Scale').listen();
  }

  public override renderDebug(): void {}

  public override dispose(): void {
    this.paramsBuffer?.destroy();
    this.compositeParamsBuffer?.destroy();
    this.defaultExposureBuffer?.destroy();
    this.volumetricRT?.destroy();
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

  /** Return the first DirectionalLightComponent found in the scene, or null. */
  private getFirstDirectionalLight(): DirectionalLightComponent | null {
    try {
      const dirLights =
        Engine.getEntities().getObjectManagerByName('directional_light')?.getList() ?? [];
      return dirLights.length > 0 ? (dirLights[0] as DirectionalLightComponent) : null;
    } catch {
      return null;
    }
  }

  /**
   * Get (or lazily create) the CSM bind group for the volumetric technique (group 2).
   * Returns null when no directional light with shadows exists in the scene.
   * Cached by the shadow-map view pointer — rebuilt only when the view changes.
   */
  private getOrCreateCSMBindGroup(): GPUBindGroup | null {
    const dl = this.getFirstDirectionalLight();
    if (!dl || !dl.getHasShadows()) return null;

    const view0 = dl.getShadowDepthView(0);
    if (!view0) return null;

    // Re-use cached bind group if the primary shadow view hasn't changed.
    if (view0 === this.cachedShadowView0 && this.csmBindGroup) {
      return this.csmBindGroup;
    }

    this.cachedShadowView0 = view0;
    // Fall back to cascade 0 for scenes with fewer than 3 cascades.
    const view1 = dl.getShadowDepthView(1) ?? view0;
    const view2 = dl.getShadowDepthView(2) ?? view0;

    this.csmBindGroup = BindGroupFactory.createBindGroup(
      'god_rays_csm_bindgroup',
      this.volumetricTechnique.getPipeline().getBindGroupLayout(2),
      [
        { binding: 0, resource: { buffer: dl.getUniformBuffer() } },
        { binding: 1, resource: view0 },
        { binding: 2, resource: view1 },
        { binding: 3, resource: view2 },
        { binding: 4, resource: dl.getShadowSampler() },
      ],
    );
    return this.csmBindGroup;
  }

  /**
   * Write VolumetricGodRaysParams and composite params into their GPU buffers.
   * Also reads sun colour from the directional light for the composite tint.
   */
  private updateParamsBuffer(): void {
    this.paramsData[0] = this.density;
    this.paramsData[1] = Math.max(this.density, this.extinction); // σt ≥ σs
    this.paramsData[2] = this.intensity;
    this.paramsData[3] = this.isEnabled ? 1.0 : 0.0;
    this.paramsData[4] = Math.max(1, this.numSteps);
    // [5–7] padding — left as 0
    GPUUtils.writeBuffer(this.paramsBuffer, 0, this.paramsData);

    // Sun colour for the composite tint (falls back to white if no light found).
    let sunR = 1.0;
    let sunG = 1.0;
    let sunB = 1.0;
    const dl = this.getFirstDirectionalLight();
    if (dl) {
      const color = dl.getColor();
      sunR = color[0] ?? 1.0;
      sunG = color[1] ?? 1.0;
      sunB = color[2] ?? 1.0;
    }

    this.compositeParamsData[0] = sunR;
    this.compositeParamsData[1] = sunG;
    this.compositeParamsData[2] = sunB;
    this.compositeParamsData[3] = this.isEnabled ? this.compositeScale : 0.0;
    GPUUtils.writeBuffer(this.compositeParamsBuffer, 0, this.compositeParamsData);
  }

  /** Get (or lazily create) the Kawase-output bind group for the composite pass. */
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
   */
  private rebuildKawaseInputBindGroups(): void {
    const layout = this.kawaseTechnique.getPipeline().getBindGroupLayout(1);
    const views = [
      this.volumetricRT.getView(), // index 0: Step 1 output → Kawase pass 0 input
      this.kawasePingA.getView(), //  index 1: Kawase pingA
      this.kawasePingB.getView(), //  index 2: Kawase pingB
    ];
    this.kawaseInputBGs = views.map((view, i) =>
      BindGroupFactory.createBindGroup(`god_rays_kawase_input_${i}`, layout, [
        { binding: 0, resource: view },
        { binding: 1, resource: SamplerLibrary.simpleSampler },
      ]),
    );
  }
}
