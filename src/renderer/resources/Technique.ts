import { ResourceManager } from "../../core/engine/ResourceManager";
import { Render } from "../core/render";
import { Mesh } from "./Mesh";

export class Technique {
  private name!: string;
  private module!: GPUShaderModule;
  private pipeline!: GPURenderPipeline;
  private blendMode!: string;
  private rasterizationMode!: string;
  private depthMode!: string;

  private uniformBuffer!: GPUBuffer;
  private bindGroup!: GPUBindGroup;
  private bindGroupLayout!: GPUBindGroupLayout;

  constructor(name: string) {
    this.name = name;
  }

  public static async get(techniquePath: string): Promise<Technique> {
    if (ResourceManager.hasResource(techniquePath)) {
      return ResourceManager.getResource<Technique>(techniquePath);
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

    // Crear buffer uniforme para todas las matrices (view, projection, model)
    this.uniformBuffer = device.createBuffer({
      label: `${this.name}_uniformBuffer`,
      size: 3 * 16 * 4, // 3 matrices 4x4 (view, projection, model)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Crear layout para el bind group
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' }
        }
      ]
    });

    // Crear el bind group
    this.bindGroup = device.createBindGroup({
      label: `${this.name}_bindGroup`,
      layout: this.bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer }
        }
      ]
    });
  }

  public createRenderPipeline(mesh: Mesh): void {
    const device = Render.getInstance().getDevice();
    const render = Render.getInstance();

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout]
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
        targets: [{
          format: render.getFormat(),
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
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back'
      },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: true,
        depthCompare: 'less'
      }
    });
  }

  public updateMatrices(viewMatrix: Float32Array, projectionMatrix: Float32Array, modelMatrix: Float32Array): void {
    if (!this.uniformBuffer) return;

    const device = Render.getInstance().getDevice();
    
    // Update viewMatrix
    device.queue.writeBuffer(
      this.uniformBuffer,
      0,  // viewMatrix offset
      viewMatrix.buffer
    );

    // Update projectionMatrix
    device.queue.writeBuffer(
      this.uniformBuffer,
      16 * 4,  // projectionMatrix offset
      projectionMatrix.buffer
    );

    // Update modelMatrix
    device.queue.writeBuffer(
      this.uniformBuffer,
      32 * 4,  // modelMatrix offset
      modelMatrix.buffer
    );
  }

  public activate(): void {
    const pass = Render.getInstance().getPass();
    if (!pass) return;
    console.log("Activating technique:", this.name);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
  }
}