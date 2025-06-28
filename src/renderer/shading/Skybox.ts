import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/Render';
import { Cubemap } from '../resources/Cubemap';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';

export class Skybox {
  private fullscreenQuadMesh!: Mesh;

  private skyboxTechnique!: Technique;
  private skyboxBindGroup!: GPUBindGroup;
  private skyboxTexture!: Cubemap;

  constructor() { }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.skyboxTechnique = await Technique.get('skybox.tech');

    this.skyboxTexture = await Cubemap.get('skybox.png');

    const textureView = this.skyboxTexture.getTextureView();
    const sampler = this.skyboxTexture.getSampler();
    if (!textureView || !sampler) {
      throw new Error('Failed to get skybox texture view or sampler');
    }
    this.skyboxBindGroup = BindGroupFactory.createBindGroup(
      `skybox_bindgroup`,
      this.skyboxTechnique.getPipeline().getBindGroupLayout(1)!,
      [
        {
          binding: 0,
          resource: textureView,
        },
        {
          binding: 1,
          resource: sampler,
        },
      ]
    );
  }

  public render(rtAccLight: GPUTextureView, depthStencilView: GPUTextureView): void {
    const render = Render.getInstance();

    const colorAttachment = GPUUtils.createColorAttachment(rtAccLight, 'load', 'store');
    const depthAttachment = GPUUtils.createDepthStencilAttachment(depthStencilView, 'load', 'store');

    const pass = render.getCommandEncoder().beginRenderPass(
      GPUUtils.createRenderPassDescriptor(
        'skybox render pass',
        [colorAttachment],
        depthAttachment
      )
    );    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    GPUUtils.configureViewportAndScissor(pass);

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
