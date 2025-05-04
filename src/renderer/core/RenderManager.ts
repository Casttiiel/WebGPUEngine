import { RenderComponent } from "../../components/render/RenderComponent";
import { Camera } from "../../core/math/Camera";
import { Transform } from "../../core/math/Transform";
import { RenderCategory } from "../../types/RenderCategory.enum";
import { Material } from "../resources/material";
import { Mesh } from "../resources/Mesh";
import { Render } from "./render";

interface RenderKey {
  mesh: Mesh;
  material: Material;
  owner: RenderComponent;
  transform: Transform;
  aabb: unknown | null;
  submeshId: number;
  instancedGroupId: number;
  isInstanced: boolean;
  usesCustomBuffers: boolean;
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
    transform: Transform,
    submeshId: number,
    instancedGroupId: number = 0
  ): void {
    const key: RenderKey = {
      mesh,
      material,
      owner,
      transform,
      aabb: null,
      submeshId,
      instancedGroupId,
      isInstanced: false,
      usesCustomBuffers: false,
    };

    this.normalKeys.push(key);
  }

  public delKeys(owner: RenderComponent): void {
    this.normalKeys = this.normalKeys.filter((key) => key.owner !== owner);
  }

  public render(category: RenderCategory): void {
    if (!this.camera) return;

    // Ordenar las keys por material
    this.normalKeys.sort((k1, k2) => {
      // Primero ordenar por material
      if (k1.material.getCategory() !== k2.material.getCategory()) {
        return k1.material.getCategory().localeCompare(k2.material.getCategory());
      }
      if (k1.material.getPriority() !== k2.material.getPriority()) {
        return k1.material.getPriority() - k2.material.getPriority();
      }
      return k1.material.getName().localeCompare(k2.material.getName());
    });

    let numDrawCalls = 0;
    const pass = Render.getInstance().getPass();
    if (!pass) return;

    for (const key of this.normalKeys) {
      if (!key.material || !key.mesh || !key.transform) {
        console.warn("Invalid render key - missing components");
        continue;
      }

      // 1. Activar el pipeline
      key.material.getTechnique().activatePipeline();

      // 2. Activar mesh data
      key.mesh.activate(pass);

      // 3. Actualizar uniforms
      const modelMatrix = new Float32Array(key.transform.asMatrix());
      key.material.getTechnique().updateMatrices(modelMatrix);

      // 4. Activar bind groups
      key.material.getTechnique().activate(key.material.getTextureBindGroup());

      // 5. Dibujar la mesh
      if (key.isInstanced) {
        //key.mesh.renderInstanced(key.submeshId, key.instancedGroupId);
      } else {
        key.mesh.renderGroup();
      }

      numDrawCalls++;
    }

    this.drawCallsPerCategory.set(category, numDrawCalls);
  }

  public getDrawCallsForCategory(category: RenderCategory): number {
    return this.drawCallsPerCategory.get(category) || 0;
  }
}