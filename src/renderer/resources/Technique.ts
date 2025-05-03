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

  private objectUniformBuffer!: GPUBuffer;
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

  public createRenderPipeline(mesh: Mesh): void {
    const device = Render.getInstance().getDevice();
    const render = Render.getInstance();

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [
        this.bindGroupLayout,  // group 0: model matrix
        render.getGlobalBindGroupLayout()  // group 1: view/projection matrices
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
        targets: [{
          format: render.getFormat()
        }]
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back'//TODO use cullmode data
      },
      depthStencil: {
        depthWriteEnabled: true, //TODO use depthMode
        depthCompare: 'less', //TODO use depthMode
        format: 'depth24plus-stencil8'
      }
    });
  }

  private initializeBuffers(): void {
    const device = Render.getInstance().getDevice();

    // Crear buffer uniforme para la matriz model
    this.objectUniformBuffer = device.createBuffer({
      label: `${this.name}_objectUniformBuffer`,
      size: 16 * 4, // 1 matriz 4x4 (model)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Crear layout para el bind group específico del objeto
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          // Model matrix
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' }
        }
      ]
    });

    // Crear el bind group que solo contiene la matriz del modelo
    this.bindGroup = device.createBindGroup({
      label: `${this.name}_bindGroup`,
      layout: this.bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.objectUniformBuffer }
        }
      ]
    });
  }

  public updateModelMatrix(modelMatrix: Float32Array): void {
    if (!this.objectUniformBuffer) return;

    const device = Render.getInstance().getDevice();
    // Update modelMatrix uniform
    device.queue.writeBuffer(
      this.objectUniformBuffer,
      0,
      modelMatrix.buffer
    );
  }

  public activate(): void {
    const pass = Render.getInstance().getPass();
    if (!pass) return;

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);  // Model matrix
    pass.setBindGroup(1, Render.getInstance().getGlobalBindGroup());  // View/projection matrices
  }
}