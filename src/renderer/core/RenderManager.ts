import { TransformComponent } from "../../components/core/TransformComponent";
import { RenderComponent } from "../../components/render/RenderComponent";
import { Engine } from "../../core/engine/Engine";
import { Camera } from "../../core/math/Camera";
import { RenderCategory } from "../../types/RenderCategory.enum";
import { Material } from "../resources/material";
import { Mesh } from "../resources/Mesh";

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

  private constructor() { }

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

    // Ordenar las keys por material
    /*this.normalKeys.sort((k1, k2) => {
      // Primero ordenar por material
      if (k1.material.getCategory() !== k2.material.getCategory()) {
        return k1.material.getCategory().localeCompare(k2.material.getCategory());
      }
      if (k1.material.getPriority() !== k2.material.getPriority()) {
        return k1.material.getPriority() - k2.material.getPriority();
      }
      return k1.material.getName().localeCompare(k2.material.getName());
    });*/

    const keysToDraw = this.normalKeys.filter(key => 
      key.material.getCategory() === category
    );

    let numDrawCalls = 0;


    for (const key of keysToDraw) {
      if (!key.material || !key.mesh || !key.transform) {
        console.warn("Invalid render key - missing components");
        continue;
      }

      // 1. Activar el pipeline
      key.material.getTechnique().activatePipeline(pass);

      // 2. Activar mesh data
      key.mesh.activate(pass);

      // 3. Actualizar uniforms
      //const modelMatrix = new Float32Array(key.transform.asMatrix());
      //key.material.getTechnique().updateMatrices(modelMatrix);

      // 4. Activar bind groups
      //ESTAMOS DANDO POR HECHO QUE TODAS LAS CATEGORIAS VAN A NECESITAR ESTOS DATOS Y PUEDE NO SER ASI EN EL FUTURO
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