import { BlendModes } from './BlendModes.enum';
import { DepthModes } from './DepthModes.enum';
import { FragmentShaderTargets } from './FragmentShaderTargets.enum';
import { PipelineBindGroupLayouts } from './PipelineBindGroupLayouts.enum';
import { RasterizationMode } from './RasterizationMode.enum';

export type TechniqueDataType = Readonly<{
  vs: string;
  fs: string;
  blend: BlendModes;
  rs: RasterizationMode;
  z: DepthModes;
  writesOn: FragmentShaderTargets;
  uniforms: ReadonlyArray<PipelineBindGroupLayouts>;
}>;
