import { mat4, vec3 } from "gl-matrix";
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
    console.log(`Adding render key for entity: ${owner.getOwner().getName()}`);
    console.log(`Current transform matrix:`, transform.asMatrix());

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
    console.log(`Total render keys after adding: ${this.normalKeys.length}`);
  }

  public delKeys(owner: RenderComponent): void {
    const beforeCount = this.normalKeys.length;
    this.normalKeys = this.normalKeys.filter((key) => key.owner !== owner);
    const afterCount = this.normalKeys.length;
    console.log(`Removed ${beforeCount - afterCount} keys for entity: ${owner.getOwner().getName()}`);
  }

  public render(category: RenderCategory): void {
    if (!this.camera) return;

    // Ordenar las keys por material y distancia a la cámara
    this.normalKeys.sort((k1, k2) => {
      // Primero ordenar por material
      if (k1.material !== k2.material) {
        if (k1.material.getCategory() !== k2.material.getCategory()) {
          return k1.material.getCategory().localeCompare(k2.material.getCategory());
        }
        if (k1.material.getPriority() !== k2.material.getPriority()) {
          return k1.material.getPriority() - k2.material.getPriority();
        }
        return k1.material.getName().localeCompare(k2.material.getName());
      }

      // Luego ordenar por distancia a la cámara (back-to-front para objetos transparentes, front-to-back para opacos)
      const pos1 = k1.transform.getPosition();
      const pos2 = k2.transform.getPosition();
      const dist1 = vec3.sqrDist(pos1, this.camera.getPosition());
      const dist2 = vec3.sqrDist(pos2, this.camera.getPosition());
      
      if (k1.material.getCategory() === 'transparent') {
        return dist2 - dist1; // Back-to-front para transparentes
      }
      return dist1 - dist2; // Front-to-back para opacos
    });

    console.log(`\n=== Starting Render Pass ===`);
    console.log(`Number of objects to render: ${this.normalKeys.length}`);
    let numDrawCalls = 0;
    let currentMaterial: Material | null = null;

    const viewMatrix = new Float32Array(this.camera.getView());
    const projectionMatrix = new Float32Array(this.camera.getProjection());

    for (const key of this.normalKeys) {
      if (!key.material || !key.mesh || !key.transform) {
        console.warn("Invalid render key - missing components");
        continue;
      }

      console.log(`\nRendering entity: ${key.owner.getOwner().getName()}`);
      console.log(`Position in world space:`, key.transform.getPosition());

      const pass = Render.getInstance().getPass();
      if (!pass) continue;

      // Solo activar el material si es diferente al anterior
      if (currentMaterial !== key.material) {
        key.material.activate();
        currentMaterial = key.material;
      }

      // Actualizar todas las matrices
      const modelMatrix = new Float32Array(key.transform.asMatrix());
      key.material.getTechnique().updateMatrices(viewMatrix, projectionMatrix, modelMatrix);

      // Activar mesh data
      key.mesh.activate(pass);

      // Dibujar la malla
      if (key.isInstanced) {
        //key.mesh.renderInstanced(key.submeshId, key.instancedGroupId);
      } else {
        key.mesh.renderGroup();
      }

      numDrawCalls++;
    }

    console.log(`\nTotal draw calls executed: ${numDrawCalls}`);
    console.log(`=== Render Pass Complete ===\n`);
    this.drawCallsPerCategory.set(category, numDrawCalls);
  }
}