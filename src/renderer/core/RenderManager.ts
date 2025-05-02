import { mat4 } from "gl-matrix";
import { RenderComponent } from "../../components/render/RenderComponent";
import { Camera } from "../../core/math/Camera";
import { Transform } from "../../core/math/Transform";
import { RenderCategory } from "../../types/RenderCategory.enum";
import { Material } from "../resources/material";
import { Mesh } from "../resources/mesh";
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

    // If the material casts shadows, add a shadow key
    if (material.getCastsShadows()) {
      const shadowKey: RenderKey = {
        ...key,
        material: material.getShadowsMaterial(),
      };
      this.normalKeys.push(shadowKey);
    }

    // If the material casts shadows, add a shadow key
    if (material.getCastsShadows()) {
      const shadowKey: RenderKey = {
        ...key,
        material: material.getShadowsMaterial(),
      };
      this.normalKeys.push(shadowKey);
    }
  }

  public delKeys(owner: RenderComponent): void {
    this.normalKeys = this.normalKeys.filter((key) => key.owner !== owner);
  }

  public render(category: RenderCategory): void {
    if (!this.camera) return;

    // Sort keys if required
    this.normalKeys.sort((k1, k2) => this.sortKeys(k1, k2));

    let numDrawCalls = 0;
    let currentMaterial: Material | null = null;

    for (const key of this.normalKeys) {
      if (!key.material || !key.mesh || !key.transform) continue;

      // Only activate material if it changes
      if (currentMaterial !== key.material) {
        key.material.activate();
        currentMaterial = key.material;
      }

      // Calculate MVP matrix
      const modelMatrix = key.transform.asMatrix();
      const mvpMatrix = mat4.create();
      mat4.multiply(mvpMatrix, this.camera.getViewProjection(), modelMatrix);

      // Update uniforms with MVP matrix
      key.material.getTechnique().updateUniforms(new Float32Array(mvpMatrix));

      // Render the mesh
      key.mesh.activate(Render.getInstance().getPass()!);
      if (key.isInstanced) {
        key.mesh.renderInstanced(key.submeshId, key.instancedGroupId);
      } else {
        key.mesh.renderGroup();
      }

      numDrawCalls++;
    }

    this.drawCallsPerCategory.set(category, numDrawCalls);
  }

  private sortKeys(k1: RenderKey, k2: RenderKey): number {
    if (k1.material !== k2.material) {
      if (k1.material.getCategory() !== k2.material.getCategory()) {
        return k1.material.getCategory().localeCompare(k2.material.getCategory());
      }
      if (k1.material.getPriority() !== k2.material.getPriority()) {
        return k1.material.getPriority() - k2.material.getPriority();
      }
      return k1.material.getName().localeCompare(k2.material.getName());
    }
    if (k1.mesh !== k2.mesh) {
      return k1.mesh.getName().localeCompare(k2.mesh.getName());
    }
    return k1.submeshId - k2.submeshId;
  }
}