import { Engine } from "../../core/engine/Engine";
import { ResourceManager } from "../../core/engine/ResourceManager";
import { RenderCategory } from "../../types/RenderCategory.enum";
import { Render } from "../core/render";
import { Mesh } from "./Mesh";
import { Texture } from "./Texture";

export class Technique {
  private name!: string;
  private module!: GPUShaderModule;
  private pipeline!: GPURenderPipeline;
  private blendMode!: string;
  private rasterizationMode!: string;
  private depthMode!: string;

  private uniformBuffer!: GPUBuffer;
  private textureBindGroupLayout!: GPUBindGroupLayout;
  private modelBindGroupLayout!: GPUBindGroupLayout;
  private modelBindGroup!: GPUBindGroup;

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
    this.depthMode = techniqueData.z || "default";

    const vsData = await ResourceManager.loadShader(techniqueData.vs);
    const fsData = await ResourceManager.loadShader(techniqueData.fs);

    const device = Render.getInstance().getDevice();

    this.module = device.createShaderModule({
      label: `${this.name}_shaderModule`,
      code: `${vsData}\n${fsData}`,
    });

    this.initializeBuffers();
  }

  private initializeBuffers(): void {
    const device = Render.getInstance().getDevice();

    // Crear buffer uniforme para la model matrix
    this.uniformBuffer = device.createBuffer({
      label: `${this.name}_uniformBuffer`,
      size: 16 * 4, // 1 matriz 4x4 (model)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Layout para texturas
    this.textureBindGroupLayout = device.createBindGroupLayout({
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
        }
      ]
    });

    // Layout para la matriz de modelo
    this.modelBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' }
        }
      ]
    });

    // Bind group para la matriz de modelo
    this.modelBindGroup = device.createBindGroup({
      label: `${this.name}_modelBindGroup`,
      layout: this.modelBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer }
        }
      ]
    });
  }

  public createTextureBindGroup(texture: Texture): GPUBindGroup {
    return Render.getInstance().getDevice().createBindGroup({
      layout: this.textureBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: texture.getTextureView()
        },
        {
          binding: 1,
          resource: texture.getSampler()
        }
      ]
    });
  }

  public createRenderPipeline(mesh: Mesh, category: RenderCategory): void {
    const device = Render.getInstance().getDevice();

    const pipelineLayout = device.createPipelineLayout({
      label: `${this.name}_pipelineLayout`,
      bindGroupLayouts: [
        Engine.getRender().getGlobalBindGroupLayout(),
        this.modelBindGroupLayout,
        this.textureBindGroupLayout
      ]
    });

    this.pipeline = device.createRenderPipeline({
      label: `${this.name}_pipeline`,
      layout: pipelineLayout,
      vertex: {
        module: this.module,
        entryPoint: 'vs',
        buffers: mesh.getVertexBufferLayout()
      },
      fragment: {
        module: this.module,
        entryPoint: 'fs',
        targets: this.getFragmentShaderTargetsBasedOnCategory(category)
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back'
      },
      depthStencil: {
        format: 'depth32float-stencil8',
        depthWriteEnabled: true,
        depthCompare: 'less'
      }
    });
  }

  private getFragmentShaderTargetsBasedOnCategory(category: RenderCategory): GPUColorTargetState[] {
    //TODO this should have logic based on the category

    switch (category) {
      case RenderCategory.SOLIDS: {
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
      default: {
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
    }
  }


  public updateMatrices(modelMatrix: Float32Array): void {
    if (!this.uniformBuffer) return;

    const device = Render.getInstance().getDevice();

    // Update modelMatrix
    device.queue.writeBuffer(
      this.uniformBuffer,
      0,  // modelMatrix offset
      modelMatrix.buffer
    );
  }

  public activatePipeline(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
  }

  public activate(pass: GPURenderPassEncoder, textureBindGroup: GPUBindGroup): void {
    pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup());
    pass.setBindGroup(1, this.modelBindGroup);
    pass.setBindGroup(2, textureBindGroup);
  }
}