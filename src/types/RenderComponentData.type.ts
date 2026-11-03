import { MaterialDataType } from './MaterialData.type';

export type RenderComponentDataType = Readonly<{
  meshes: ReadonlyArray<RenderComponentMeshDataType>;
  isInstanced?: boolean; // Flag indicating this entity is instanced
  instanceGroup?: string; // Group identifier for instancing
  /**
   * Shadow caching (ShadowCache): 'static' casters are drawn once per light and cached,
   * 'movable' ones every frame. Default: static unless the entity animates or has a dynamic /
   * kinematic collider; a static object that moves turns movable on its own.
   */
  mobility?: 'static' | 'movable';
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
