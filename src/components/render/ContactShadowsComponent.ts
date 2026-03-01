import { Component } from '../../core/ecs/Component';
import { DirectionalLightComponent } from './DirectionalLightComponent';
import { RenderTarget } from '../../renderer/resources/RenderTarget';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { RenderPassManager } from '../../renderer/core/passes/RenderPassManager';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { Render } from '../../renderer/core/pipeline/Render';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Engine } from '../../core/engine/Engine';

/**
 * ContactShadowsComponent
 *
 * Screen-space contact shadow pass driven by the scene's directional light.
 * Place on the MainCamera entity alongside AmbientOcclusionComponent.
 *
 * The pass reads the G-Buffer and ray-marches each pixel toward the directional
 * light. Where the ray hits geometry it darkens the accumulated-light buffer,
 * producing crisp contact shadows under objects close to the ground.
 *
 * Data layout of ContactShadowParams uniform (32 bytes):
 *   [0-2] lightDir    vec3<f32>  world-space direction FROM surface TOWARD light
 *   [3]   intensity   f32        shadow opacity  (0–1)
 *   [4]   stepLength  f32        world-space step size in metres
 *   [5]   maxDistance f32        max ray travel distance in metres
 *   [6]   thickness   f32        linearDepth tolerance for hit detection
 *   [7]   enabled     f32        1 = on, 0 = off
 */
export class ContactShadowsComponent extends Component {
  // ─── GPU resources ───────────────────────────────────────────────────────
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private result!: RenderTarget;
  private renderPassManager!: RenderPassManager;
  private paramsBuffer!: GPUBuffer;

  // ─── Bind group cache ────────────────────────────────────────────────────
  /** Invalidated whenever the accLight view changes (i.e. after a resize). */
  private paramsBindGroup: GPUBindGroup | null = null;
  private lastAccLightView: GPUTextureView | null = null;

  // ─── Tuneable parameters (exposed for debug UI) ──────────────────────────
  public isEnabled: boolean = true;
  /** Opacity of the contact shadow [0, 1]. */
  public intensity: number = 0.6;
  /** World-space ray step length in metres. Smaller = more accurate, more expensive. */
  public stepLength: number = 0.04;
  /** Maximum ray travel distance in metres. Larger = wider shadow coverage. */
  public maxDistance: number = 0.4;
  /** LinearDepth hit-detection tolerance. Tune to avoid false shadows on thin faces. */
  public thickness: number = 0.015;

  private loaded = false;

  // ─── Reusable Float32Array to avoid allocations on hot path ─────────────
  private readonly paramsData = new Float32Array(8);

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.technique = await Technique.getAsync('post-processing/contact_shadows.tech');

    const format = QualitySettings.getInstance().getSettings().hdrTexture;
    this.result = new RenderTarget();
    this.result.createRT('contact_shadows_result.dds', Render.width, Render.height, format);

    // 8 floats × 4 bytes = 32 bytes, matching ContactShadowParams in WGSL
    this.paramsBuffer = GPUUtils.createBuffer(
      'contact_shadows_params_buffer',
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.renderPassManager = new RenderPassManager();
    this.loaded = true;
  }

  public resize(): void {
    if (!this.loaded) return;
    const format = QualitySettings.getInstance().getSettings().hdrTexture;
    this.result.destroy();
    this.result = new RenderTarget();
    this.result.createRT('contact_shadows_result.dds', Render.width, Render.height, format);
    // Invalidate bind group — it holds a reference to the old accLight view
    this.paramsBindGroup = null;
    this.lastAccLightView = null;
  }

  // ─── Per-frame apply ─────────────────────────────────────────────────────

  /**
   * Apply contact shadows to the accumulated-light buffer.
   *
   * @param accLightView   GPUTextureView of the accumulated light render target.
   * @param gBufferBindGroup  Standard GBuffer bind group (group 1).
   * @returns              GPUTextureView of the result (accLight × shadow factor).
   */
  public apply(accLightView: GPUTextureView, gBufferBindGroup: GPUBindGroup): GPUTextureView {
    if (!this.loaded) return accLightView;

    this.updateParamsBuffer();

    // Recreate bind group whenever the input view changes (e.g. after resize)
    if (!this.paramsBindGroup || this.lastAccLightView !== accLightView) {
      this.paramsBindGroup = BindGroupFactory.createBindGroup(
        'contact_shadows_params_bindgroup',
        this.technique.getPipeline().getBindGroupLayout(2),
        [
          { binding: 0, resource: accLightView },
          { binding: 1, resource: SamplerLibrary.simpleSampler },
          { binding: 2, resource: { buffer: this.paramsBuffer } },
        ],
      );
      this.lastAccLightView = accLightView;
    }

    this.renderPassManager.executeContactShadowsPass(
      this.fullscreenQuadMesh,
      this.technique,
      gBufferBindGroup,
      this.paramsBindGroup,
      this.result,
    );

    return this.result.getView();
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  private updateParamsBuffer(): void {
    // Default light direction: straight up (no shadowing unless a light is present)
    let lx = 0.0;
    let ly = 1.0;
    let lz = 0.0;

    // Find the first directional light and use its direction
    const dirLights =
      Engine.getEntities().getObjectManagerByName('directional_light')?.getList() ?? [];
    if (dirLights.length > 0) {
      const dl = dirLights[0] as DirectionalLightComponent;
      const dir = dl.getLightDirectionToSource();
      lx = dir[0];
      ly = dir[1];
      lz = dir[2];
    }

    this.paramsData[0] = lx;
    this.paramsData[1] = ly;
    this.paramsData[2] = lz;
    this.paramsData[3] = this.intensity;
    this.paramsData[4] = this.stepLength;
    this.paramsData[5] = this.maxDistance;
    this.paramsData[6] = this.thickness;
    this.paramsData[7] = this.isEnabled ? 1.0 : 0.0;

    GPUUtils.writeBuffer(this.paramsBuffer, 0, this.paramsData);
  }

  // ─── Component API ───────────────────────────────────────────────────────

  public hasLoaded(): boolean {
    return this.loaded;
  }

  public override update(_dt: number): void {}

  public renderDebug(): void {}

  public dispose(): void {
    this.paramsBuffer?.destroy();
    this.result?.destroy();
  }
}
