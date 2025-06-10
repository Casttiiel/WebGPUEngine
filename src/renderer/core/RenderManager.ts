import { TransformComponent } from '../../components/core/TransformComponent';
import { RenderComponent } from '../../components/render/RenderComponent';
import { Engine } from '../../core/engine/Engine';
import { Camera } from '../../core/math/Camera';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { Material } from '../resources/material';
import { Mesh } from '../resources/Mesh';

interface RenderKey {
  mesh: Mesh;
  material: Material;
  owner: RenderComponent;
  transform: TransformComponent;
  aabb: unknown | null;
  isInstanced: boolean;
}

export class RenderManager {
  private static instance: RenderManager | null = null;
  private normalKeys: RenderKey[] = [];
  private drawCallsPerCategory: Map<RenderCategory, number> = new Map();
  private camera!: Camera;

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
      aabb: null,
      isInstanced: false,
    };

    this.normalKeys.push(key);
  }

  public delKeys(owner: RenderComponent): void {
    this.normalKeys = this.normalKeys.filter((key) => key.owner !== owner);
  }

  public render(category: RenderCategory, pass: GPURenderPassEncoder): void {
    if (!this.camera) return;

    // Reset estado
    this.currentPipeline = null;
    this.currentMeshBuffers = null;
    this.currentMaterialBindings = null;

    // Filtrar primero por categoría y crear una copia para no modificar el array original
    const keysToDraw = [...this.normalKeys].filter((key) => key.material.getCategory() === category);

    // Ordenar las keys: técnica > material > mesh para minimizar cambios de estado
    keysToDraw.sort((k1, k2) => {
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
