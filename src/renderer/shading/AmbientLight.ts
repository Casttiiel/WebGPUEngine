import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/render';
import { Cubemap } from '../resources/Cubemap';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { Texture } from '../resources/Texture';

export class AmbientLight {
  private fullscreenQuadMesh!: Mesh;
  private whiteTexture!: Texture;
  private environmentTexture!: Cubemap;

  private ambientTechnique!: Technique;
  private gBufferBindGroup!: GPUBindGroup;
  private environmentBindGroup!: GPUBindGroup;

  constructor() {}

  public create(
    rtAlbedos: GPUTextureView,
    rtNormals: GPUTextureView,
    rtLinearDepth: GPUTextureView,
    rtSelfIllum: GPUTextureView,
  ): void {
    const sampler = this.environmentTexture.getSampler();
    this.gBufferBindGroup = Render.getInstance()
      .getDevice()
      .createBindGroup({
        label: `ambient_bindgroup`,
        layout: this.ambientTechnique.getPipeline().getBindGroupLayout(1),
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

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.ambientTechnique = await Technique.get('ambient.tech');
    this.whiteTexture = await Texture.get('white.png');

    this.environmentTexture = await Cubemap.get('skybox.png');

    this.environmentBindGroup = Render.getInstance()
      .getDevice()
      .createBindGroup({
        label: `skybox_bindgroup`,
        layout: this.ambientTechnique.getPipeline().getBindGroupLayout(2),
        entries: [
          {
            binding: 0,
            resource: this.environmentTexture.getTextureView(),
          },
          {
            binding: 1,
            resource: this.environmentTexture.getSampler(),
          },
        ],
      });
  }

  public render(rtAccLight: GPUTextureView): void {
    const render = Render.getInstance();
    const pass = render.getCommandEncoder().beginRenderPass({
      colorAttachments: [
        {
          view: rtAccLight,
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
    this.ambientTechnique.activatePipeline(pass);

    // 2. Activar mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Activar bind groups
    pass.setBindGroup(0, Engine.getRender().getGlobalBindGroup()); // Camera uniforms
    pass.setBindGroup(1, this.gBufferBindGroup); // GBuffer textures
    pass.setBindGroup(2, this.environmentBindGroup); // Environment texture

    // 4. Dibujar la mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }
}
