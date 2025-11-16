import { MaterialDataType } from './MaterialData.type';

export type RenderComponentDataType = Readonly<{
  meshes: ReadonlyArray<RenderComponentMeshDataType>;
  isInstanced?: boolean; // Flag indicating this entity is instanced
  instanceGroup?: string; // Group identifier for instancing
}>;

export type RenderComponentMeshDataType = Readonly<{
  mesh?: string;
  meshData?: {
    attributes: {
      NORMAL: unknown;
      POSITION: unknown;
      TANGENT: unknown;
      TEXCOORD_0: unknown;
    };
    indices: unknown;
  };
  material?: string;
  materialData?: MaterialDataType;
  visible?: boolean;
  state?: number;
}>;
