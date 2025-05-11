import { Engine } from "../../core/engine/Engine";
import { ResourceManager } from "../../core/engine/ResourceManager";
import { FragmentShaderTargets } from "../../types/FragmentShaderTargets.enum";
import { PipelineBindGroupLayouts } from "../../types/PipelineBindGroupLayouts.enum";
import { RenderCategory } from "../../types/RenderCategory.enum";
import { Render } from "../core/render";
import { Mesh } from "./Mesh";

export class Technique {
  private name!: string;
  private module!: GPUShaderModule;
  private pipeline!: GPURenderPipeline;
  private blendMode!: string;
  private rasterizationMode!: string;
  private depthTest!: string;
  private writesOn!: FragmentShaderTargets;
  private uniformsLayout: ReadonlyArray<PipelineBindGroupLayouts> = [];

  constructor(name: string) {
    this.name = name;
  }

  public static async get(techniquePath: string): Promise<Technique> {
    if (ResourceManager.hasResource(techniquePath)) {
      //return ResourceManager.getResource<Technique>(techniquePath);
    }

    const technique = new Technique(techniquePath);
    await technique.load();
    ResourceManager.setResource(techniquePath, technique);
    return technique;
  }

  public async load(): Promise<void> {
    const techniqueData = await ResourceManager.loadTechniqueData(this.name);

    this.blendMode = techniqueData.blend || "default";
    this.rasterizationMode = techniqueData.rs || "default";
    this.depthTest = techniqueData.z || "default";
    this.writesOn = techniqueData.writesOn || FragmentShaderTargets.SCREEN;
    this.uniformsLayout = techniqueData.uniforms;

    const vsData = await ResourceManager.loadShader(techniqueData.vs);
    const fsData = await ResourceManager.loadShader(techniqueData.fs);

    const device = Render.getInstance().getDevice();

    this.module = device.createShaderModule({
      label: `${this.name}_shaderModule`,
      code: `${vsData}\n${fsData}`,
    });
  }

  public createRenderPipeline(mesh: Mesh): void {
    const device = Render.getInstance().getDevice();

    let pipelineParams = {
      label: `${this.name}_pipeline`,
      layout: this.getPipelineUniformLayout(),
      vertex: {
        module: this.module,
        entryPoint: 'vs',
        buffers: mesh.getVertexBufferLayout()
      },
      fragment: {
        module: this.module,
        entryPoint: 'fs',
        targets: this.getFragmentShaderTarget()
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back'
      },
    } as GPURenderPipelineDescriptor;

    if (this.depthTest && this.depthTest !== "none") {
      pipelineParams.depthStencil = {
        format: 'depth32float-stencil8',
        depthWriteEnabled: true,
        depthCompare: 'less'
      };
    }

    this.pipeline = device.createRenderPipeline(pipelineParams);
  }

  private getPipelineUniformLayout(): "auto" | GPUPipelineLayout {
    if (!this.uniformsLayout || this.uniformsLayout.length === 0) {
      return 'auto';
    }

    const device = Render.getInstance().getDevice();
    const layouts = [] as GPUBindGroupLayout[];

    for (const uniform of this.uniformsLayout) {
      switch (uniform) {
        case PipelineBindGroupLayouts.CAMERA_UNIFORMS: {
          layouts.push(device.createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' }
              }
            ]
          }));
          break;
        }
        case PipelineBindGroupLayouts.MATERIAL_TEXTURES: {
          layouts.push(device.createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'float' }
              },
              {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: 'filtering' }
              },
              {
                binding: 2,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'float' }
              },
              {
                binding: 3,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: 'filtering' }
              },
              {
                binding: 4,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'float' }
              },
              {
                binding: 5,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: 'filtering' }
              },
              {
                binding: 6,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'float' }
              },
              {
                binding: 7,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: 'filtering' }
              },
              {
                binding: 8,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: 'float' }
              },
              {
                binding: 9,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: 'filtering' }
              }
            ]
          }));
          break;
        }
        case PipelineBindGroupLayouts.OBJECT_UNIFORMS: {
          layouts.push(device.createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' }
              }
            ]
          }));
          break;
        }
        default: {
          throw new Error(`${this.name}: Unknown uniform layout`)
        }
      }
    }

    return device.createPipelineLayout({
      label: `${this.name}_pipelineLayout`,
      bindGroupLayouts: layouts
    });
  }

  private getFragmentShaderTarget(): GPUColorTargetState[] {
    switch (this.writesOn) {
      case FragmentShaderTargets.GBUFFER: {
        return [{
          format: 'rgba16float',
        },
        {
          format: 'rgba16float',
        },
        {
          format: 'rgba16float',
        },
        {
          format: 'r16float',
        }];
        break;
      }
      case FragmentShaderTargets.TEXTURE: {
        return [{
          format: 'rgba16float',
        }];
        break;
      }
      case FragmentShaderTargets.SCREEN: {
        return [{
          format: Render.getInstance().getFormat(),
          blend: {
            color: {
              srcFactor: 'one',
              dstFactor: 'zero',
              operation: 'add',
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'zero',
              operation: 'add',
            }
          }
        }]
        break;
      }
      default: {
        throw new Error(`${this.name}: Unknown Fragment Shader Target`)
      }
    }
  }

  public activatePipeline(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
  }

  public getPipeline(): GPURenderPipeline {
    return this.pipeline;
  }
}