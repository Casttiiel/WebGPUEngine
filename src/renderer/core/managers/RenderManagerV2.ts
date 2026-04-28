import { RenderComponent } from '../../../components/render/RenderComponent';
import { TransformComponent } from '../../../components/core/TransformComponent';
import { Camera } from '../../../core/math/Camera';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { Material } from '../../resources/Material';
import { Mesh } from '../../resources/Mesh';
import { Technique } from '../../resources/Technique';
import { CPUCullingManager } from '../culling/CPUCullingManager';
import { GPUCullingManager } from '../culling/GPUCullingManager';
import { Logger } from '../../../core/debug/Logger';
import { HZBCullingPass } from '../culling/HZBCullingPass';
import { RenderKeyManager, RenderKey } from './RenderKeyManager';
import { RenderStateManager } from './RenderStateManager';
import { Render } from '../pipeline/Render';
import { HZBBuilder } from '../culling/HZBBuilder';

export class RenderManagerV2 {
  private static instance: RenderManagerV2 | null = null;

  // Managers
  private keyManager: RenderKeyManager;
  private stateManager: RenderStateManager;
  private cpuCuller: CPUCullingManager | null = null;
  private gpuCuller: GPUCullingManager | null = null;
  private hzbCullingPass: HZBCullingPass | null = null;
  private hzbBuilder: HZBBuilder | null = null;
  /** Diagnostic flag: set to false to bypass HZB occlusion culling without recompiling. */
  private hzbEnabled = true;

  // ---- HZB false-cull debug readback ----------------------------------------
  private debugHZBEnabled = false;
  /** Staging buffer for reading indirectArgsBuffer back to CPU. */
  private debugStagingBuffer: GPUBuffer | null = null;
  private debugStagingCapacity = 0;
  private debugMapPending = false;
  private debugStagingMapped = false;
  /** Set when the indirect args copy was recorded into the current frame's main encoder. */
  private debugIndirectCopyInMainEncoder = false;
  /** Camera snapshot used for the CPU reference culling comparison. */
  private debugLastCamera: Camera | null = null;

  // State
  private camera: Camera | null = null;
  private drawCallsPerCategory: Map<RenderCategory, number> = new Map();
  private techniqueOverride: Technique | null = null;
  private techniqueOverrideInstanced: Technique | null = null;
  private techniqueOverrideMask: Technique | null = null;
  private techniqueOverrideMaskInstanced: Technique | null = null;
  private techniqueOverrideSkinned: Technique | null = null;
  private gpuCullingEstimatedVisible: number = 0;

  // Cached shadow keys — rebuilt only when markDirty() fires (addKey/delKeys)
  private cachedShadowKeys: RenderKey[] | null = null;
  // Pre-sorted shadow keys — same sort used for every cascade, built once per key-change
  private sortedShadowKeys: RenderKey[] | null = null;
  // Indirect buffer written by the last dispatchShadow() call; consumed by renderKeys()
  private currentShadowIndirectBuffer: GPUBuffer | null = null;

  private constructor() {
    this.keyManager = new RenderKeyManager();
    this.stateManager = new RenderStateManager();
  }

  public static getInstance(): RenderManagerV2 {
    if (!RenderManagerV2.instance) {
      RenderManagerV2.instance = new RenderManagerV2();
    }
    return RenderManagerV2.instance;
  }

  public async initialize(): Promise<void> {
    // CPU culling — used for shadow cameras and as fallback
    this.cpuCuller = new CPUCullingManager();

    // GPU culling — used for the main camera (no readback, zero CPU overhead)
    this.gpuCuller = new GPUCullingManager();
    await this.gpuCuller.initialize();

    // HZB occlusion culling — layered on top of GPU frustum culling
    this.hzbCullingPass = new HZBCullingPass();
    await this.hzbCullingPass.initialize();

    Logger.info('RENDER', 'Culling ready  CPU · GPU · HZB');
  }

  public setCamera(camera: Camera): void {
    this.camera = camera;
  }

  public setHZBBuilder(hzbBuilder: HZBBuilder): void {
    this.hzbBuilder = hzbBuilder;
  }

  public setTechniqueOverride(
    technique: Technique,
    instancedTechnique?: Technique,
    maskTechnique?: Technique,
    maskInstancedTechnique?: Technique,
    skinnedTechnique?: Technique,
  ): void {
    this.techniqueOverride = technique;
    this.techniqueOverrideInstanced = instancedTechnique || null;
    this.techniqueOverrideMask = maskTechnique || null;
    this.techniqueOverrideMaskInstanced = maskInstancedTechnique || null;
    this.techniqueOverrideSkinned = skinnedTechnique || null;
  }

  public clearTechniqueOverride(): void {
    this.techniqueOverride = null;
    this.techniqueOverrideInstanced = null;
    this.techniqueOverrideMask = null;
    this.techniqueOverrideMaskInstanced = null;
    this.techniqueOverrideSkinned = null;
  }

  public addKey(
    owner: RenderComponent,
    mesh: Mesh,
    material: Material,
    transform: TransformComponent,
    isInstanced: boolean = false,
    instanceCount: number = 1,
    instanceBindGroup?: GPUBindGroup,
    renderBindGroup?: GPUBindGroup,
    indirectDrawBuffer?: GPUBuffer,
  ): void {
    this.keyManager.addKey(
      owner,
      mesh,
      material,
      transform,
      isInstanced,
      instanceCount,
      instanceBindGroup,
      renderBindGroup,
      indirectDrawBuffer,
    );
    if (material.getCastsShadows()) {
      this.keyManager.addKey(
        owner,
        mesh,
        material.getShadowsMaterial(),
        transform,
        isInstanced,
        instanceCount,
        instanceBindGroup,
        renderBindGroup,
        indirectDrawBuffer,
      );
    }

    // Mark GPU culler dirty so it rebuilds on next performCulling()
    this.gpuCuller?.markDirty();
    this.cachedShadowKeys = null; // Invalidate shadow key cache
    this.sortedShadowKeys = null;
  }

  public delKeys(owner: RenderComponent): void {
    this.keyManager.removeKeys(owner);
    this.gpuCuller?.markDirty();
    this.cachedShadowKeys = null; // Invalidate shadow key cache
    this.sortedShadowKeys = null;
  }

  public performCulling(camera: Camera, category?: RenderCategory): void {
    const allKeys = this.keyManager.getAllKeys();

    if (category !== undefined) {
      // Shadow / light camera path.
      // The shadow key list is cached and rebuilt only when keys are added/removed.
      if (this.cachedShadowKeys === null) {
        this.cachedShadowKeys = [];
        for (let i = 0; i < allKeys.length; i++) {
          if (allKeys[i]!.material.getCategory() === category) {
            this.cachedShadowKeys.push(allKeys[i]!);
          }
        }
      }

      if (this.gpuCuller?.isShadowReady()) {
        // GPU path: one compute dispatch per shadow camera, no CPU array alloc.
        // The returned buffer holds DrawIndexedIndirectParameters written by the shader.
        const encoder = Render.getInstance().getCommandEncoder();
        this.currentShadowIndirectBuffer = this.gpuCuller.dispatchShadow(encoder, camera);
        // Sort shadow keys once per key-change — same order for all cascades
        if (this.sortedShadowKeys === null) {
          this.sortedShadowKeys = [...this.cachedShadowKeys!];
          this.keyManager.sortKeys(this.sortedShadowKeys, RenderCategory.SHADOWS, undefined);
        }
        // Hand sorted keys to the camera — GPU zeros instanceCount for culled ones
        camera.setCulledKeys(this.sortedShadowKeys);
      } else {
        // CPU fallback (GPU culler not yet ready)
        this.currentShadowIndirectBuffer = null;
        const culledKeys = this.cpuCuller!.performCulling(this.cachedShadowKeys, camera);
        camera.setCulledKeys(culledKeys);
      }
      return;
    }

    // Main camera path — GPU culling
    if (this.gpuCuller?.isInitialized()) {
      // Rebuild GPU buffers if keys changed since last rebuild
      if (this.gpuCuller.isDirty()) {
        this.gpuCuller.rebuild(allKeys);
      }

      // Dispatch the compute shader on the current frame encoder (no readback)
      const encoder = Render.getInstance().getCommandEncoder();
      this.gpuCuller.dispatch(encoder, camera);

      // NOTE: HZB occlusion culling is NOT dispatched here.  It runs later, between
      // the depth_prepass and the GBuffer pass, via dispatchHZBCulling() called from
      // DeferredRenderer.  This ordering guarantees:
      //   1. depth_prepass always renders ALL frustum-visible objects (no HZB applied).
      //   2. HZB is built from a complete depth buffer (no missing occluded objects).
      //   3. HZB culling only affects the GBuffer, which skips fully-occluded geometry.
      // Without this separation the HZB creates a self-reinforcing loop: culled objects
      // are absent from depth → absent from HZB → culled again the next frame, forever.

      // CPU-side estimate for the debug UI (pure AABB math, no array alloc)
      this.gpuCullingEstimatedVisible = this.cpuCuller!.countVisible(
        this.gpuCuller.getManagedKeys(),
        camera,
      );

      // Pass ALL keys to the camera — GPU handles visibility via instanceCount=0.
      // Shadow keys have their own pool rebuilt in GPUCullingManager.rebuildShadow().
      camera.setCulledKeys(allKeys);
      return;
    }

    // Fallback: CPU culling (GPU culler not yet initialized)
    const culledKeys = this.cpuCuller!.performCulling(allKeys, camera);
    camera.setCulledKeys(culledKeys);
  }

  public performLightCulling(camera: Camera): void {
    this.cpuCuller!.performLightCulling(camera);
  }

  /**
   * Dispatches HZB occlusion culling on the shared frame encoder.
   *
   * Must be called AFTER the depth prepass and AFTER HZBBuilder.build() so the
   * pyramid reflects the current frame's complete depth.  Call from DeferredRenderer
   * between the depth_prepass and the GBuffer render passes.
   *
   * Using this.camera (set by setCamera() before DeferredRenderer.render() is called).
   */
  public dispatchHZBCulling(encoder: GPUCommandEncoder): void {
    if (!this.hzbEnabled || !this.hzbCullingPass || !this.hzbBuilder?.isReady()) return;
    if (!this.camera || !this.gpuCuller?.isInitialized()) return;

    const objBuf = this.gpuCuller.getObjectDataBuffer();
    const indBuf = this.gpuCuller.getIndirectArgsBuffer();
    if (!objBuf || !indBuf) return;

    // Sync debug flag so HZBCullingPass logs the per-cull breakdown when enabled.
    this.hzbCullingPass.debugEnabled = this.debugHZBEnabled;

    this.hzbCullingPass.dispatch(
      encoder,
      this.camera,
      objBuf,
      indBuf,
      this.gpuCuller.getManagedCount(),
      this.hzbBuilder,
    );

    // Debug readback: compare GPU result vs CPU frustum to isolate HZB false culls
    if (this.debugHZBEnabled && !this.debugMapPending && !this.debugIndirectCopyInMainEncoder) {
      if (this.debugStagingMapped) {
        this.processDebugReadback();
      }
      this.scheduleDebugReadback(encoder, indBuf, this.gpuCuller.getManagedCount(), this.camera);
    }
  }

  /**
   * Must be called AFTER Render.endFrame() submits the main frame encoder.
   * Starts GPU readback mapAsync for HZB counters and debug buffers that were
   * copied into the main encoder this frame.
   */
  public postFrame(): void {
    this.hzbCullingPass?.postFrame();

    // Indirect args debug readback (for [HZB FALSE CULLS] output)
    if (this.debugIndirectCopyInMainEncoder && !this.debugMapPending && !this.debugStagingMapped) {
      this.debugIndirectCopyInMainEncoder = false;
      this.debugMapPending = true;
      this.debugStagingBuffer!.mapAsync(GPUMapMode.READ)
        .then(() => {
          this.debugMapPending = false;
          this.debugStagingMapped = true;
        })
        .catch(() => {
          this.debugMapPending = false;
        });
    }
  }

  public render(category: RenderCategory, pass: GPURenderPassEncoder): void {
    if (!this.camera) return;

    // Reset render state for this pass
    this.stateManager.reset();

    // Fast path for GPU-culled shadow passes: keys are already filtered (shadow-only)
    // and pre-sorted — skip the O(n) filter loop and O(n log n) sort entirely.
    if (category === RenderCategory.SHADOWS && this.sortedShadowKeys !== null) {
      const keys = this.camera.getCulledKeys();
      if (keys === this.sortedShadowKeys) {
        const drawCalls = this.renderKeys(keys as RenderKey[], pass);
        this.drawCallsPerCategory.set(category, drawCalls);
        return;
      }
    }

    // ✅ Manual loop instead of filter() to avoid array allocation
    const keys = this.camera.getCulledKeys();
    const keysToDraw: RenderKey[] = [];
    for (let i = 0; i < keys.length; i++) {
      if (keys[i]!.material.getCategory() === category) {
        keysToDraw.push(keys[i]!);
      }
    }

    // Sort keys for optimal rendering
    this.keyManager.sortKeys(keysToDraw, category, this.camera);

    // Render the keys
    const drawCalls = this.renderKeys(keysToDraw, pass);
    this.drawCallsPerCategory.set(category, drawCalls);
  }

  /**
   * Renders VIEW_MODEL category keys using the provided camera, bypassing
   * all frustum/HZB culling. First-person weapons are always visible.
   */
  public renderViewModelKeys(camera: Camera, pass: GPURenderPassEncoder): void {
    const allKeys = this.keyManager.getAllKeys();
    this.stateManager.reset();
    this.stateManager.setBindGroup(pass, 0, camera.getBindGroup());

    let drawCalls = 0;
    for (let i = 0; i < allKeys.length; i++) {
      const key = allKeys[i]!;
      if (key.material.getCategory() !== RenderCategory.VIEW_MODEL) continue;
      if (!this.validateRenderKey(key)) continue;

      const technique = key.material.getTechnique();
      if (!technique) continue;

      this.stateManager.setPipeline(pass, technique.getPipeline()!, () =>
        technique.activatePipeline(pass),
      );
      this.stateManager.setMeshBuffers(pass, key.mesh.getName(), () => key.mesh.activate(pass));
      this.stateManager.setMaterialBindings(
        pass,
        key.material.getName(),
        key.material.getTextureBindGroup(),
        1,
      );
      this.stateManager.setBindGroup(pass, 2, key.transform.getModelBindGroup());
      if (key.renderBindGroup) {
        this.stateManager.setBindGroup(pass, 3, key.renderBindGroup);
      }

      key.mesh.renderGroup(pass);
      drawCalls++;
    }
    this.drawCallsPerCategory.set(RenderCategory.VIEW_MODEL, drawCalls);
  }

  public getDrawCallsForCategory(category: RenderCategory): number {
    return this.drawCallsPerCategory.get(category) || 0;
  }

  public getAllKeys(): RenderKey[] {
    return this.keyManager.getAllKeys();
  }

  /**
   * Returns GPU culling statistics for the debug UI.
   * managed — keys dispatched via indirect draw (GPU culls them)
   * total   — all registered keys including shadows / particles
   * active  — whether the GPU path is initialized and in use
   */
  public getGPUCullerStats(): {
    managed: number;
    total: number;
    active: boolean;
    estimatedVisible: number;
  } {
    return {
      managed: this.gpuCuller?.getManagedCount() ?? 0,
      total: this.keyManager.getAllKeys().length,
      active: this.gpuCuller?.isInitialized() ?? false,
      estimatedVisible: this.gpuCullingEstimatedVisible,
    };
  }

  /**
   * Number of objects culled by the HZB occlusion pass in the most recent
   * completed frame (1-frame GPU readback lag).
   */
  public getHZBCulledCount(): number {
    return this.hzbCullingPass?.getCulledCount() ?? 0;
  }

  /** Toggle HZB occlusion culling on/off at runtime for diagnostic purposes. */
  public setHZBEnabled(enabled: boolean): void {
    this.hzbEnabled = enabled;
  }

  public isHZBEnabled(): boolean {
    return this.hzbEnabled;
  }

  /**
   * Enable/disable the HZB false-cull debug readback.
   * When enabled, every frame that has HZB culls will console.warn() the mesh names
   * of objects that the CPU frustum culler considers visible but the GPU HZB cull set
   * to instanceCount=0.  Those are the HZB false positives causing disappearances.
   *
   * Usage (browser console):
   *   Engine.getRender().getRenderManager().setHZBDebugEnabled(true)
   */
  public setHZBDebugEnabled(enabled: boolean): void {
    this.debugHZBEnabled = enabled;
    if (!enabled) {
      this.debugStagingBuffer?.destroy();
      this.debugStagingBuffer = null;
      this.debugStagingCapacity = 0;
      this.debugMapPending = false;
      this.debugStagingMapped = false;
      this.debugIndirectCopyInMainEncoder = false;
    }
  }

  private scheduleDebugReadback(
    encoder: GPUCommandEncoder,
    indBuf: GPUBuffer,
    n: number,
    camera: Camera,
  ): void {
    const size = n * 20; // INDIRECT_STRIDE = 5 × u32 = 20 bytes
    const device = Render.getInstance().getDevice();
    if (!device) return;

    if (!this.debugStagingBuffer || this.debugStagingCapacity < size) {
      this.debugStagingBuffer?.destroy();
      this.debugStagingBuffer = device.createBuffer({
        label: 'hzb_debug_staging',
        size: Math.max(size, 64),
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      this.debugStagingCapacity = size;
    }

    this.debugLastCamera = camera;

    // Record copy into the MAIN frame encoder so the HZB cull's writes are
    // guaranteed visible before the copy executes.  postFrame() calls mapAsync.
    encoder.copyBufferToBuffer(indBuf, 0, this.debugStagingBuffer, 0, size);
    this.debugIndirectCopyInMainEncoder = true;
  }

  private processDebugReadback(): void {
    if (!this.debugStagingMapped || !this.debugStagingBuffer || !this.debugLastCamera) return;

    const managedKeys = this.gpuCuller!.getManagedKeys();
    const n = managedKeys.length;
    const mapped = new Uint32Array(this.debugStagingBuffer.getMappedRange(0, n * 20));

    // CPU reference: which keys does the frustum culler consider visible?
    const cpuVisible = new Set(this.cpuCuller!.performCulling(managedKeys, this.debugLastCamera));

    const falseCulled: string[] = [];
    for (let i = 0; i < n; i++) {
      const instanceCount = mapped[i * 5 + 1]; // u32 index 1 = instanceCount
      if (instanceCount === 0) {
        const key = managedKeys[i]!;
        if (cpuVisible.has(key)) {
          const m = key.transform.getTransform().getWorldMatrix();
          const pos = `(${m[12]?.toFixed(1)}, ${m[13]?.toFixed(1)}, ${m[14]?.toFixed(1)})`;
          const aabb = key.aabb
            ? `min(${key.aabb.min.map((v) => v.toFixed(2)).join(',')}) max(${key.aabb.max.map((v) => v.toFixed(2)).join(',')})`
            : 'no aabb';
          falseCulled.push(`  [${i}] ${key.mesh.getName()} @ ${pos}  ${aabb}`);
        }
      }
    }

    this.debugStagingBuffer.unmap();
    this.debugStagingMapped = false;

    if (falseCulled.length > 0) {
      console.warn(`[HZB FALSE CULLS] ${falseCulled.length} objects:\n` + falseCulled.join('\n'));
    }
  }

  private renderKeys(keys: RenderKey[], pass: GPURenderPassEncoder): number {
    let drawCalls = 0;

    this.stateManager.setBindGroup(pass, 0, this.camera!.getBindGroup());

    for (const key of keys) {
      if (!this.validateRenderKey(key)) {
        continue;
      }

      // Select technique based on override and instancing
      let technique: Technique;
      if (this.techniqueOverride) {
        // Use override technique for depth prepass, shadows, etc.
        const origTechnique = key.material.getTechnique();
        const origName = origTechnique?.getName() ?? '';
        const isMasked = origName.includes('mask') || origName.includes('dither');
        const isSkinned = origTechnique?.getIsSkinned() ?? false;

        if (isSkinned && this.techniqueOverrideSkinned) {
          // Skinned meshes get a dedicated override that applies joint transforms
          technique = this.techniqueOverrideSkinned;
        } else if (isSkinned) {
          // No skinned override provided — skip to avoid GPU pipeline mismatch
          continue;
        } else if (isMasked && this.techniqueOverrideMask) {
          if (key.isInstanced && this.techniqueOverrideMaskInstanced) {
            technique = this.techniqueOverrideMaskInstanced;
          } else if (key.isInstanced) {
            // No instanced mask override — fall back to non-instanced mask
            technique = this.techniqueOverrideMask;
          } else {
            technique = this.techniqueOverrideMask;
          }
        } else if (key.isInstanced && this.techniqueOverrideInstanced) {
          technique = this.techniqueOverrideInstanced;
        } else if (key.isInstanced) {
          // No instanced override available, skip this object
          console.warn('Instanced object skipped - no instanced technique override available');
          continue;
        } else {
          technique = this.techniqueOverride;
        }
      } else {
        // Normal rendering - use material's technique
        technique = key.material.getTechnique()!;
      }

      const pipeline = technique.getPipeline()!;

      // Use state manager to minimize state changes
      this.stateManager.setPipeline(pass, pipeline, () => technique.activatePipeline(pass));
      this.stateManager.setMeshBuffers(pass, key.mesh.getName(), () => key.mesh.activate(pass));
      this.stateManager.setMaterialBindings(
        pass,
        key.material.getName(),
        key.material.getTextureBindGroup(),
        1,
      );

      // @group(2): Instance storage buffer for instanced rendering, or object uniforms for normal rendering
      if (key.isInstanced && key.instanceBindGroup) {
        this.stateManager.setBindGroup(pass, 2, key.instanceBindGroup);
      } else {
        this.stateManager.setBindGroup(pass, 2, key.transform.getModelBindGroup());
      }

      // @group(3): Optional per-key bind group (skinning, particles, custom pass data).
      // Bind whenever present, regardless of draw mode.
      if (key.renderBindGroup) {
        this.stateManager.setBindGroup(pass, 3, key.renderBindGroup);
      }

      if (key.indirectDrawBuffer) {
        // Particles or main-camera GPU-culled keys
        pass.drawIndexedIndirect(key.indirectDrawBuffer, key.indirectDrawOffset);
      } else if (key.shadowIndirectOffset >= 0 && this.currentShadowIndirectBuffer) {
        // Shadow key — GPU-culled via per-dispatch indirect buffer
        pass.drawIndexedIndirect(this.currentShadowIndirectBuffer, key.shadowIndirectOffset);
      } else if (key.isInstanced) {
        key.mesh.renderInstance(pass, key.instanceCount);
      } else {
        key.mesh.renderGroup(pass);
      }
      drawCalls++;
    }

    return drawCalls;
  }

  private validateRenderKey(key: RenderKey): boolean {
    if (!key.material || !key.mesh || !key.transform) {
      console.warn('Invalid render key - missing components');
      return false;
    }

    // Check if mesh GPU buffers are ready
    if (!key.mesh.isGPUReady()) {
      // Silent skip - mesh is still loading
      return false;
    }

    const technique = key.material.getTechnique();
    if (!technique) {
      console.warn('Invalid render key - missing technique');
      return false;
    }

    const pipeline = technique.getPipeline();
    if (!pipeline) {
      console.warn('Invalid render key - missing pipeline');
      return false;
    }

    // For custom-slot materials, the bind group is built lazily once all engine
    // textures are registered.  Skip silently until it's ready to avoid submitting
    // draw calls with an unbound group 1.
    if (technique.getMaterialSlots() !== null && !key.material.getTextureBindGroup()) {
      return false;
    }

    return true;
  }

  public destroy(): void {
    if (this.cpuCuller) {
      this.cpuCuller.dispose();
      this.cpuCuller = null;
    }

    if (this.gpuCuller) {
      this.gpuCuller.dispose();
      this.gpuCuller = null;
    }

    if (this.hzbCullingPass) {
      this.hzbCullingPass.dispose();
      this.hzbCullingPass = null;
    }

    this.hzbBuilder = null;

    this.keyManager.clear();
    this.stateManager.clear();

    this.camera = null;
    this.drawCallsPerCategory.clear();

    RenderManagerV2.instance = null;
  }
}
