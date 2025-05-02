import { Material } from "../render/material";
import { Mesh } from "../render/mesh";

export type MeshPartType = {
    mesh: Mesh;
    material: Material;
    meshGroup: number;
    meshInstancesGroup: number;
    isVisible: boolean;
    state: number;
}