import { Material } from '../renderer/resources/material';
import { Mesh } from '../renderer/resources/Mesh';

export type MeshPartType = {
  mesh: Mesh;
  material: Material;
  isVisible: boolean;
};
