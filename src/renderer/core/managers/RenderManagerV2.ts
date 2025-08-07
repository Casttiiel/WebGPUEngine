import { RenderComponent } from '../../../components/render/RenderComponent';
import { TransformComponent } from '../../../components/core/TransformComponent';
import { Camera } from '../../../core/math/Camera';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { Material } from '../../resources/Material';
import { Mesh } from '../../resources/Mesh';
import { GPUFrustumCuller } from '../../culling/GPUFrustumCuller';
import { TemporalCullingManager } from '../culling/TemporalCullingManager';
import { RenderKeyManager, RenderKey } from './RenderKeyManager';
import { RenderStateManager } from './RenderStateManager';

export class RenderManagerV2 {
  private static instance: RenderManagerV2 | null = null;

  // Managers
  private keyManager: RenderKeyManager;
  private stateManager: RenderStateManager;
  private frustumCuller: GPUFrustumCuller | null = null;
  private temporalCuller: TemporalCullingManager | null = null;

  // State
  private camera: Camera | null = null;
  private culledKeys: RenderKey[] = [];
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
    console.log('RenderManagerV2: Initializing with temporal culling...');

    // Initialize GPU frustum culler
    this.frustumCuller = new GPUFrustumCuller();
    await this.frustumCuller.load();

    // Initialize temporal culling system
    this.temporalCuller = new TemporalCullingManager(this.frustumCuller);

    console.log('RenderManagerV2: Temporal culling system initialized');
  }

  public setCamera(camera: Camera): void {
    this.camera = camera;
  }

  public addKey(
    owner: RenderComponent,
    mesh: Mesh,
    material: Material,
    transform: TransformComponent,
  ): void {
    this.keyManager.addKey(owner, mesh, material, transform);
    if (material.getCastsShadows()) {
      this.keyManager.addKey(owner, mesh, material.getShadowsMaterial(), transform);
    }
  }

  public delKeys(owner: RenderComponent): void {
    this.keyManager.removeKeys(owner);
  }

  public performPreRenderCulling(): void {
    if (!this.camera) return;

    const allKeys = this.keyManager.getAllKeys();

    this.culledKeys = this.temporalCuller!.performCulling(allKeys, this.camera);
  }

  public render(category: RenderCategory, pass: GPURenderPassEncoder): void {
    if (!this.camera) return;

    // Reset render state for this pass
    this.stateManager.reset();

    // Filter culled keys by category
    let keys = this.culledKeys;
    if (category === RenderCategory.SHADOWS) {
      keys = this.getAllKeys();
    }
    const keysToDraw = keys.filter((key) => key.material.getCategory() === category);

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

  public getCulledKeys(): RenderKey[] {
    return this.culledKeys;
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
      this.stateManager.setBindGroup(pass, 1, key.transform.getModelBindGroup());

      // Set material bind group (cache aware)
      this.stateManager.setMaterialBindings(
        pass,
        key.material.getName(),
        key.material.getTextureBindGroup(),
        2,
      );

      // Draw the mesh
      key.mesh.renderGroup(pass);
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
    if (this.frustumCuller) {
      this.frustumCuller.dispose();
      this.frustumCuller = null;
    }

    if (this.temporalCuller) {
      this.temporalCuller.dispose();
      this.temporalCuller = null;
    }

    this.keyManager.clear();
    this.stateManager.clear();

    this.camera = null;
    this.culledKeys = [];
    this.drawCallsPerCategory.clear();

    RenderManagerV2.instance = null;
  }
}
