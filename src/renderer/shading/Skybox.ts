import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/render';
import { Cubemap } from '../resources/Cubemap';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';

export class Skybox {
  private fullscreenQuadMesh!: Mesh;

  private skyboxTechnique!: Technique;
  private skyboxBindGroup!: GPUBindGroup;
  private skyboxTexture!: Cubemap;

  constructor() {}

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.skyboxTechnique = await Technique.get('skybox.tech');

    this.skyboxTexture = await Cubemap.get('skybox.png', {
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const textureView = this.skyboxTexture.getTextureView();
    const sampler = this.skyboxTexture.getSampler();
    if (!textureView || !sampler) {
      throw new Error('Failed to get skybox texture view or sampler');
    }

    this.skyboxBindGroup = Render.getInstance()
      .getDevice()
      .createBindGroup({
        label: `skybox_bindgroup`,
        layout: this.skyboxTechnique.getPipeline().getBindGroupLayout(1),
        entries: [
          {
            binding: 0,
            resource: textureView,
          },
          {
            binding: 1,
            resource: sampler,
          },
        ],
      });
  }

  public render(rtAccLight: GPUTextureView, depthStencilView: GPUTextureView): void {
    const render = Render.getInstance();

    const pass = render.getCommandEncoder().beginRenderPass({
      colorAttachments: [
        {
          view: rtAccLight,
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthStencilView,
        depthLoadOp: 'load',
        depthStoreOp: 'discard',
      },
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
    this.skyboxTechnique.activatePipeline(pass);

    // 2. Activar mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Activar bind groups
    pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup());
    pass.setBindGroup(1, this.skyboxBindGroup);

    // 4. Dibujar la mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }
}
