import { Engine } from '../../core/engine/Engine';
import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/render';
import { RenderToTexture } from '../../renderer/core/RenderToTexture';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';

export class AntialiasingComponent extends Component {
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private bindGroup!: GPUBindGroup | null;
  private result!: RenderToTexture;

  constructor() {
    super();
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');

    this.technique = await Technique.get('antialiasing.tech');

    this.result = new RenderToTexture();
    this.result.createRT('antialiasing_result.dds', Render.width, Render.height, 'rgba16float');
  }

  public resize(): void {
    this.result.createRT('antialiasing_result.dds', Render.width, Render.height, 'rgba16float');
    this.bindGroup = null;
  }

  public apply(texture: GPUTextureView): GPUTextureView {
    this.setBindGroup(texture);
    const render = Render.getInstance();
    const pass = render.getCommandEncoder().beginRenderPass({
      colorAttachments: [
        {
          view: this.result.getView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });

    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    pass.setViewport(
      0,
      0, // Offset X,Y
      render.getCanvas().width, // Width
      render.getCanvas().height, // Height
      0.0,
      1.0, // Min/max depth
    );

    pass.setScissorRect(
      0,
      0, // Offset X,Y
      render.getCanvas().width, // Width
      render.getCanvas().height, // Height
    );

    // 1. Activar el pipeline
    this.technique.activatePipeline(pass);

    // 2. Activar mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Activar bind groups
    pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup());
    pass.setBindGroup(1, this.bindGroup);

    // 4. Dibujar la mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();

    return this.result.getView();
  }

  private setBindGroup(texture: GPUTextureView): void {
    if (this.bindGroup) return;

    const device = Render.getInstance().getDevice();
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.bindGroup = device.createBindGroup({
      label: `antialiasing_bindgroup`,
      layout: this.technique.getPipeline().getBindGroupLayout(1),
      entries: [
        {
          binding: 0,
          resource: texture,
        },
        {
          binding: 1,
          resource: sampler,
        },
      ],
    });
  }

  public update(dt: number): void {
    throw new Error('Method not implemented.');
  }

  public debugInMenu(): void {
    // Implement debug menu if needed
  }

  public renderDebug(): void {
    // Implement debug rendering if needed
  }
}
