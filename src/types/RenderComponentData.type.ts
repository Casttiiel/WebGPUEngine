import { MaterialDataType } from './MaterialData.type';

export type RenderComponentDataType = Readonly<{
  meshes: ReadonlyArray<RenderComponentMeshDataType>;
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
  instances_group?: number;
  visible?: boolean;
  state?: number;
}>;
