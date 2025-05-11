import { FragmentShaderTargets } from "./FragmentShaderTargets.enum";
import { PipelineBindGroupLayouts } from "./PipelineBindGroupLayouts.enum";

export type TechniqueDataType = Readonly<{
    vs: string;
    fs: string;
    blend: string;
    rs: string;
    z: string;
    writesOn: FragmentShaderTargets;
    uniforms: ReadonlyArray<PipelineBindGroupLayouts>;
}>;