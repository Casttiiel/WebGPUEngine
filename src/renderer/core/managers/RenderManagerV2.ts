import { RenderComponent } from '../../../components/render/RenderComponent';
import { TransformComponent } from '../../../components/core/TransformComponent';
import { Camera } from '../../../core/math/Camera';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { Material } from '../../resources/Material';
import { Mesh } from '../../resources/Mesh';
import { CPUCullingManager } from '../culling/CPUCullingManager';
import { RenderKeyManager, RenderKey } from './RenderKeyManager';
import { RenderStateManager } from './RenderStateManager';

export class RenderManagerV2 {
  private static instance: RenderManagerV2 | null = null;

  // Managers
  private keyManager: RenderKeyManager;
  private stateManager: RenderStateManager;
  private cpuCuller: CPUCullingManager | null = null;

  // State
  private camera: Camera | null = null;
  private drawCallsPerCategory: Map<RenderCategory, number> = new Map();

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
    console.log('RenderManagerV2: Initializing with CPU culling...');

    // Initialize CPU culling system
    this.cpuCuller = new CPUCullingManager();

    console.log('RenderManagerV2: CPU culling system initialized');
  }

  public setCamera(camera: Camera): void {
    this.camera = camera;
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
  }

  public delKeys(owner: RenderComponent): void {
    this.keyManager.removeKeys(owner);
  }

  public performCulling(camera: Camera, category?: RenderCategory): void {
    let keysToCull = this.keyManager.getAllKeys();

    // ✅ Manual loop instead of filter() to avoid array allocation
    if (category !== undefined) {
      const filteredKeys: RenderKey[] = [];
      for (let i = 0; i < keysToCull.length; i++) {
        if (keysToCull[i]!.material.getCategory() === category) {
          filteredKeys.push(keysToCull[i]!);
        }
      }
      keysToCull = filteredKeys;
    }

    const culledKeys = this.cpuCuller!.performCulling(keysToCull, camera);
    camera.setCulledKeys(culledKeys);
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

  private renderKeys(keys: RenderKey[], pass: GPURenderPassEncoder): number {
    let drawCalls = 0;

    this.stateManager.setBindGroup(pass, 0, this.camera!.getBindGroup());

    for (const key of keys) {
      if (!this.validateRenderKey(key)) {
        continue;
      }

      const technique = key.material.getTechnique()!;
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
        this.stateManager.setBindGroup(pass, 3, key.renderBindGroup!);
        pass.drawIndexedIndirect(key.indirectDrawBuffer, 0);
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

    this.keyManager.clear();
    this.stateManager.clear();

    this.camera = null;
    this.drawCallsPerCategory.clear();

    RenderManagerV2.instance = null;
  }
}
