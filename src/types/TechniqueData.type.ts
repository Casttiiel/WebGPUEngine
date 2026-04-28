import { BlendModes } from './BlendModes.enum';
import { DepthModes } from './DepthModes.enum';
import { FragmentShaderTargets } from './FragmentShaderTargets.enum';
import { PipelineBindGroupLayouts } from './PipelineBindGroupLayouts.enum';
import { RasterizationMode } from './RasterizationMode.enum';

/**
 * Declares a single binding slot for a custom-material technique.
 * When a technique has `materialSlots`, Material builds a dynamic bind group
 * instead of the fixed 5-texture PBR schema.
 */
export interface TechniqueMaterialSlot {
  /** Key used in the .mat "textures" record to supply a per-material override. */
  name: string;
  /** @group(1) @binding(N) index in WGSL. */
  binding: number;
  /** Resource kind — determines the GPUBindGroupLayoutEntry type. */
  type: 'texture2d' | 'texturecube' | 'depth_texture' | 'sampler' | 'uniform';
  /**
   * Value used when the .mat file does not provide this slot:
   *   "@engine:<name>"  → EngineTextureRegistry (rebuilt on resize)
   *   "@sampler:<key>"  → SamplerLibrary[key]
   *   any other string  → Texture.getAsync(path)
   */
  defaultValue?: string;
}

export type TechniqueDataType = Readonly<{
  vs: string;
  fs: string;
  blend?: BlendModes;
  rs?: RasterizationMode;
  z?: DepthModes;
  writesOn: FragmentShaderTargets;
  uniforms: ReadonlyArray<PipelineBindGroupLayouts>;
  /** When present, Material builds a dynamic bind group instead of the fixed PBR schema. */
  materialSlots?: ReadonlyArray<TechniqueMaterialSlot>;
  /** When true, the pipeline uses the two-slot skinned vertex buffer layout (pos/norm/uv/tan + joints/weights). */
  skinned?: boolean;
}>;
