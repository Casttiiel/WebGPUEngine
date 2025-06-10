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

    // Filtrar primero por categoría y crear una copia para no modificar el array original
    const keysToDraw = [...this.normalKeys].filter((key) => key.material.getCategory() === category);

    // Ordenar las keys: técnica > material > mesh para minimizar cambios de estado
    keysToDraw.sort((k1, k2) => {
      // 1. Ordenar por técnica (minimizar cambios de pipeline)
      const tech1 = k1.material.getTechnique();
      const tech2 = k2.material.getTechnique();
      if (tech1.path !== tech2.path) {
        return tech1.path.localeCompare(tech2.path);
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

      // 1. Activar el pipeline
      key.material.getTechnique().activatePipeline(pass);

      // 2. Activar mesh data
      key.mesh.activate(pass);

      // 3. Actualizar uniforms

      // 4. Activar bind groups
      pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup());
      pass.setBindGroup(1, key.transform.getModelBindGroup());
      pass.setBindGroup(2, key.material.getTextureBindGroup());

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
