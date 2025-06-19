import { Texture } from '../../renderer/resources/Texture';
import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/Render';
import { RenderToTexture } from '../../renderer/core/RenderToTexture';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { Engine } from '../../core/engine/Engine';

export class AmbientOcclusionComponent extends Component {
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private whiteTexture!: Texture;
  private bindGroup!: GPUBindGroup | null;
  private result!: RenderToTexture;

  constructor() {
    super();
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.whiteTexture = await Texture.get('white.png');
    this.technique = await Technique.get('ambient_occlusion.tech');

    this.result = new RenderToTexture();
    this.result.createRT('ambient_occlusion_result.dds', Render.width, Render.height, 'r16float');
  }

  public resize(): void {
    this.result.createRT('ambient_occlusion_result.dds', Render.width, Render.height, 'r16float');
    this.bindGroup = null;
  }

  public compute(texture: GPUTextureView): void {
    const render = Render.getInstance();
    const pass = render.getCommandEncoder().beginRenderPass({
      colorAttachments: [
        {
          view: texture,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 1, g: 1, b: 1, a: 1 },
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
    pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup()); // Camera uniforms
    pass.setBindGroup(1, this.bindGroup); // GBuffer textures

    // 4. Dibujar la mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  public setBindGroup(
    rtAlbedos: GPUTextureView,
    rtNormals: GPUTextureView,
    rtLinearDepth: GPUTextureView,
    rtSelfIllum: GPUTextureView
  ): void {
    if (this.bindGroup) return;

    const device = Render.getInstance().getDevice();
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.bindGroup = Render.getInstance()
      .getDevice()
      .createBindGroup({
        label: `ambient_occlusion_bindgroup`,
        layout: this.technique.getPipeline().getBindGroupLayout(1),
        entries: [
          {
            binding: 0,
            resource: rtAlbedos,
          },
          {
            binding: 1,
            resource: rtNormals,
          },
          {
            binding: 2,
            resource: rtLinearDepth,
          },
          {
            binding: 3,
            resource: rtSelfIllum,
          },
          {
            binding: 4,
            resource: this.whiteTexture.getTextureView(),
          },
          {
            binding: 5,
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
