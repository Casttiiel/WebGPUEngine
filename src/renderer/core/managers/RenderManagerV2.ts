import { RenderComponent } from '../../../components/render/RenderComponent';
import { TransformComponent } from '../../../components/core/TransformComponent';
import { Camera } from '../../../core/math/Camera';
import { RenderCategory } from '../../../types/RenderCategory.enum';
import { Material } from '../../resources/Material';
import { Mesh } from '../../resources/Mesh';
import { GPUFrustumCuller, CullableObject } from '../../culling/GPUFrustumCuller';
import { RenderKeyManager, RenderKey } from './RenderKeyManager';
import { RenderStateManager } from './RenderStateManager';
import { Engine } from '../../../core/engine/Engine';

/**
 * Refactored RenderManager with improved separation of concerns
 */
export class RenderManagerV2 {
  private static instance: RenderManagerV2 | null = null;

  // Managers
  private keyManager: RenderKeyManager;
  private stateManager: RenderStateManager;
  private frustumCuller: GPUFrustumCuller | null = null;

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
    this.frustumCuller = new GPUFrustumCuller();
    await this.frustumCuller.load();
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

  public async performPreRenderCulling(): Promise<void> {
    if (!this.camera) return;

    let keysToDraw = this.keyManager.getAllKeys();

    // Apply frustum culling if available
    if (this.frustumCuller && keysToDraw.length > 0) {
      try {
        keysToDraw = await this.performGPUCulling(keysToDraw);
      } catch (error) {
        console.warn('Culling failed, rendering all objects:', error);
        keysToDraw = this.keyManager.getAllKeys();
      }
    }

    this.culledKeys = keysToDraw;
  }

  public render(category: RenderCategory, pass: GPURenderPassEncoder): void {
    if (!this.camera) return;

    // Reset render state for this pass
    this.stateManager.reset();

    // Filter culled keys by category
    const keysToDraw = this.culledKeys.filter((key) => key.material.getCategory() === category);

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

  private async performGPUCulling(keys: RenderKey[]): Promise<RenderKey[]> {
    if (!this.frustumCuller || !this.camera) return keys;

    // Convert render keys to cullable objects
    const cullableObjects: CullableObject[] = keys.map((key) => ({
      id: key.id,
      bounds: key.aabb || { min: [-1, -1, -1], max: [1, 1, 1] },
      modelMatrix: new Float32Array(key.transform.getTransform().getWorldMatrix()),
    }));

    // Perform GPU culling
    const cullResult = await this.frustumCuller.cullObjects(this.camera, cullableObjects);

    // Filter keys based on culling results
    const visibleKeys: RenderKey[] = [];
    for (const visibleIndex of cullResult.visibleIndices) {
      if (visibleIndex < keys.length) {
        const key = keys[visibleIndex];
        if (key) {
          visibleKeys.push(key);
        }
      }
    }

    return visibleKeys;
  }

  private renderKeys(keys: RenderKey[], pass: GPURenderPassEncoder): number {
    let drawCalls = 0;

    for (const key of keys) {
      if (!this.validateRenderKey(key)) {
        continue;
      }

      const technique = key.material.getTechnique()!;
      const pipeline = technique.getPipeline()!;

      // Use state manager to minimize state changes
      this.stateManager.setPipeline(pass, pipeline, () => technique.activatePipeline(pass));
      this.stateManager.setMeshBuffers(pass, key.mesh.getName(), () => key.mesh.activate(pass)); // Set bind groups - camera uniforms (always set as they may change per frame)
      this.stateManager.forceSetBindGroup(pass, 0, this.getGlobalBindGroup());
      this.stateManager.forceSetBindGroup(pass, 1, key.transform.getModelBindGroup());

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

  private getGlobalBindGroup(): GPUBindGroup {
    // This should be obtained from the render module or engine
    return Engine.getRender().getGlobalBindGroup();
  }

  public destroy(): void {
    if (this.frustumCuller) {
      this.frustumCuller.dispose();
      this.frustumCuller = null;
    }

    this.keyManager.clear();
    this.stateManager.clear();

    this.camera = null;
    this.culledKeys = [];
    this.drawCallsPerCategory.clear();

    RenderManagerV2.instance = null;
  }
}
