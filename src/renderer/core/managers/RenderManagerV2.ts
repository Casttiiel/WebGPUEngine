import { RenderComponent } from '../../../components/render/RenderComponent';
import { TransformComponent } from '../../../components/core/TransformComponent';
import { Camera } from '../../../core/math/Camera';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { Material } from '../../resources/Material';
import { Mesh } from '../../resources/Mesh';
import { Technique } from '../../resources/Technique';
import { CPUCullingManager } from '../culling/CPUCullingManager';
import { GPUCullingManager } from '../culling/GPUCullingManager';
import { RenderKeyManager, RenderKey } from './RenderKeyManager';
import { RenderStateManager } from './RenderStateManager';
import { Render } from '../pipeline/Render';

export class RenderManagerV2 {
  private static instance: RenderManagerV2 | null = null;

  // Managers
  private keyManager: RenderKeyManager;
  private stateManager: RenderStateManager;
  private cpuCuller: CPUCullingManager | null = null;
  private gpuCuller: GPUCullingManager | null = null;

  // State
  private camera: Camera | null = null;
  private drawCallsPerCategory: Map<RenderCategory, number> = new Map();
  private techniqueOverride: Technique | null = null;
  private techniqueOverrideInstanced: Technique | null = null;
  private gpuCullingEstimatedVisible: number = 0;

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
    console.log('RenderManagerV2: Initializing culling systems...');

    // CPU culling — used for shadow cameras and as fallback
    this.cpuCuller = new CPUCullingManager();

    // GPU culling — used for the main camera (no readback, zero CPU overhead)
    this.gpuCuller = new GPUCullingManager();
    await this.gpuCuller.initialize();

    console.log('RenderManagerV2: CPU + GPU culling systems initialized');
  }

  public setCamera(camera: Camera): void {
    this.camera = camera;
  }

  public setTechniqueOverride(technique: Technique, instancedTechnique?: Technique): void {
    this.techniqueOverride = technique;
    this.techniqueOverrideInstanced = instancedTechnique || null;
  }

  public clearTechniqueOverride(): void {
    this.techniqueOverride = null;
    this.techniqueOverrideInstanced = null;
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
  }

  public delKeys(owner: RenderComponent): void {
    this.keyManager.removeKeys(owner);
    this.gpuCuller?.markDirty();
  }

  public performCulling(camera: Camera, category?: RenderCategory): void {
    const allKeys = this.keyManager.getAllKeys();

    if (category !== undefined) {
      // Shadow / light camera path — CPU culling on a specific category
      const filteredKeys: RenderKey[] = [];
      for (let i = 0; i < allKeys.length; i++) {
        if (allKeys[i]!.material.getCategory() === category) {
          filteredKeys.push(allKeys[i]!);
        }
      }
      const culledKeys = this.cpuCuller!.performCulling(filteredKeys, camera);
      camera.setCulledKeys(culledKeys);
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

      // CPU-side estimate for the debug UI (pure AABB math, no array alloc)
      this.gpuCullingEstimatedVisible = this.cpuCuller!.countVisible(
        this.gpuCuller.getManagedKeys(),
        camera,
      );

      // Pass ALL keys to the camera — GPU handles visibility via instanceCount=0.
      // Shadow keys are excluded in rebuild() so they retain their CPU-only path.
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

  public render(category: RenderCategory, pass: GPURenderPassEncoder): void {
    if (!this.camera) return;

    // Reset render state for this pass
    this.stateManager.reset();

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
        // Use override technique for depth prepass, etc.
        if (key.isInstanced && this.techniqueOverrideInstanced) {
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

      if (key.indirectDrawBuffer) {
        // Only set @group(3) when the key actually has a custom render bind group
        // (particles). GPU-culled mesh keys have no renderBindGroup.
        if (key.renderBindGroup) {
          this.stateManager.setBindGroup(pass, 3, key.renderBindGroup);
        }
        pass.drawIndexedIndirect(key.indirectDrawBuffer, key.indirectDrawOffset);
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

    this.keyManager.clear();
    this.stateManager.clear();

    this.camera = null;
    this.drawCallsPerCategory.clear();

    RenderManagerV2.instance = null;
  }
}
