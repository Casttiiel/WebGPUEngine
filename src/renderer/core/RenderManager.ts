import { TransformComponent } from '../../components/core/TransformComponent';
import { RenderComponent } from '../../components/render/RenderComponent';
import { Engine } from '../../core/engine/Engine';
import { Camera } from '../../core/math/Camera';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { Material } from '../resources/Material';
import { Mesh } from '../resources/Mesh';
import { GPUFrustumCuller, CullableObject, AABB } from '../culling/GPUFrustumCuller';

interface RenderKey {
  mesh: Mesh;
  material: Material;
  owner: RenderComponent;
  transform: TransformComponent;
  aabb: AABB | null;
  isInstanced: boolean;
  id: number; // Unique ID for culling
}

export class RenderManager {
  private static instance: RenderManager | null = null;
  private normalKeys: RenderKey[] = [];
  private culledKeys: Map<RenderCategory, RenderKey[]> = new Map();
  private drawCallsPerCategory: Map<RenderCategory, number> = new Map();
  private camera!: Camera;
  private frustumCuller: GPUFrustumCuller | null = null;
  private cullingEnabled = true;
  private useCPUCulling = false; // Toggle between CPU and GPU culling
  private nextObjectId = 0;

  // Cache de estados para reducir cambios innecesarios
  private currentPipeline: GPURenderPipeline | null = null;
  private currentMeshBuffers: string | null = null;
  private currentMaterialBindings: string | null = null;

  private constructor() {}

  public static getInstance(): RenderManager {
    if (!RenderManager.instance) {
      RenderManager.instance = new RenderManager();
    }
    return RenderManager.instance;
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
    const key: RenderKey = {
      mesh,
      material,
      owner,
      transform,
      aabb: mesh.getAABB(),
      isInstanced: false,
      id: this.nextObjectId++,
    };

    this.normalKeys.push(key);
  }

  public delKeys(owner: RenderComponent): void {
    this.normalKeys = this.normalKeys.filter((key) => key.owner !== owner);
  }

  // GPU/CPU culling should be done before render passes begin
  public async performPreRenderCulling(category: RenderCategory): Promise<void> {
    if (!this.camera) return;

    // Filter by category first
    const categoryKeys = this.normalKeys.filter((key) => key.material.getCategory() === category);

    let keysToDraw = categoryKeys;

    // Apply frustum culling if enabled and available
    if (this.cullingEnabled && this.frustumCuller && categoryKeys.length > 0) {
      try {
        if (this.useCPUCulling) {
          // Use CPU culling for debugging
          keysToDraw = this.performCPUCulling(categoryKeys);
          //console.warn(`CPU Culling: ${keysToDraw.length}/${categoryKeys.length} objects visible`);
        } else {
          // Use GPU culling
          keysToDraw = await this.performGPUCulling(categoryKeys);
          //console.warn(`GPU Culling: ${keysToDraw.length}/${categoryKeys.length} objects visible`);
        }
      } catch (error) {
        console.warn('Culling failed, rendering all objects:', error);
        keysToDraw = categoryKeys;
      }
    }

    // Store culled keys for this category
    this.culledKeys.set(category, keysToDraw);
  }

  public render(category: RenderCategory, pass: GPURenderPassEncoder): void {
    if (!this.camera) return;

    // Reset state
    this.currentPipeline = null;
    this.currentMeshBuffers = null;
    this.currentMaterialBindings = null;

    // Use pre-culled keys if available, otherwise use all keys for the category
    const keysToDraw =
      this.culledKeys.get(category) ||
      this.normalKeys.filter((key) => key.material.getCategory() === category);

    // Sort keys to minimize state changes
    this.sortRenderKeys(keysToDraw); // Render visible objects
    this.renderKeys(keysToDraw, pass, category);
  }

  private async performGPUCulling(keys: RenderKey[]): Promise<RenderKey[]> {
    if (!this.frustumCuller) return keys; // Convert render keys to cullable objects
    const cullableObjects: CullableObject[] = keys.map((key) => ({
      id: key.id,
      bounds: key.aabb || { min: [-1, -1, -1], max: [1, 1, 1] },
      modelMatrix: new Float32Array(key.transform.getTransform().getWorldMatrix()),
    }));

    // Perform GPU culling
    const cullResult = await this.frustumCuller.cullObjects(this.camera, cullableObjects); // Filter keys based on culling results
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

  private sortRenderKeys(keys: RenderKey[]): void {
    // Ordenar las keys: técnica > material > mesh para minimizar cambios de estado
    keys.sort((k1, k2) => {
      // 1. Ordenar por técnica (minimizar cambios de pipeline)
      const tech1 = k1.material.getTechnique();
      const tech2 = k2.material.getTechnique();
      if (!tech1 || !tech2) return 0;

      const techPath1 = tech1.path || '';
      const techPath2 = tech2.path || '';
      if (techPath1 !== techPath2) {
        return techPath1.localeCompare(techPath2);
      }

      // 2. Si la técnica es la misma, ordenar por material (minimizar cambios de textura/uniforms)
      const mat1 = k1.material.getName();
      const mat2 = k2.material.getName();
      if (mat1 !== mat2) {
        return mat1.localeCompare(mat2);
      }

      // 3. Si el material es el mismo, ordenar por mesh (minimizar cambios de geometría)
      const mesh1 = k1.mesh.getName();
      const mesh2 = k2.mesh.getName();
      return mesh1.localeCompare(mesh2);
    });
  }

  private renderKeys(
    keysToDraw: RenderKey[],
    pass: GPURenderPassEncoder,
    category: RenderCategory,
  ): void {
    let numDrawCalls = 0;

    for (const key of keysToDraw) {
      if (!key.material || !key.mesh || !key.transform) {
        console.warn('Invalid render key - missing components');
        continue;
      }

      const technique = key.material.getTechnique();
      if (!technique) {
        console.warn('Invalid render key - missing technique');
        continue;
      }

      const pipeline = technique.getPipeline();
      if (!pipeline) {
        console.warn('Invalid render key - missing pipeline');
        continue;
      }

      // 1. Activar el pipeline solo si ha cambiado
      if (this.currentPipeline !== pipeline) {
        technique.activatePipeline(pass);
        this.currentPipeline = pipeline;
      }

      // 2. Activar mesh data solo si ha cambiado
      const meshId = key.mesh.getName();
      if (this.currentMeshBuffers !== meshId) {
        key.mesh.activate(pass);
        this.currentMeshBuffers = meshId;
      }

      // 3. Actualizar uniforms y bind groups
      // El bind group global (0) siempre se actualiza porque contiene datos de cámara
      pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup());

      // El bind group del modelo (1) siempre se actualiza porque contiene la matriz del modelo
      pass.setBindGroup(1, key.transform.getModelBindGroup());

      // 4. Bind group de material solo si ha cambiado
      const materialId = key.material.getName();
      if (this.currentMaterialBindings !== materialId) {
        const textureBindGroup = key.material.getTextureBindGroup();
        if (textureBindGroup) {
          pass.setBindGroup(2, textureBindGroup);
          this.currentMaterialBindings = materialId;
        }
      }

      // 5. Dibujar la mesh
      if (key.isInstanced) {
        //key.mesh.renderInstanced(key.submeshId, key.instancedGroupId);
      } else {
        key.mesh.renderGroup(pass);
      }

      numDrawCalls++;
    }

    this.drawCallsPerCategory.set(category, numDrawCalls);
  }

  public getDrawCallsForCategory(category: RenderCategory): number {
    return this.drawCallsPerCategory.get(category) || 0;
  }
}
