import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/Render';
import { RenderToTexture } from '../../renderer/core/RenderToTexture';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { Engine } from '../../core/engine/Engine';

export class AmbientOcclusionComponent extends Component {
  private technique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private result!: RenderToTexture;

  constructor() {
    super();
  }

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.technique = await Technique.get('ambient_occlusion.tech');

    this.result = new RenderToTexture();
    this.result.createRT(
      'ambient_occlusion_result.dds',
      Render.width,
      Render.height,
      'r16float',
      true,
    ); // Enable MSAA
  }

  public resize(): void {
    this.result.createRT(
      'ambient_occlusion_result.dds',
      Render.width,
      Render.height,
      'r16float',
      true,
    ); // Enable MSAA
  }

  public compute(gBufferBindGroup: GPUBindGroup): GPUTextureView | undefined {
    const render = Render.getInstance();

    // Create color attachment with MSAA handling
    const colorAttachment: GPURenderPassColorAttachment = {
      view: this.result.getRenderView(), // MSAA view for rendering
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 1, g: 1, b: 1, a: 1 },
    };

    const pass = render.getCommandEncoder().beginRenderPass({
      label: 'Ambient Occlusion Pass',
      colorAttachments: [colorAttachment],
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
    pass.setBindGroup(1, gBufferBindGroup); // GBuffer textures

    // 4. Dibujar la mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();

    return this.result.getView();
  }

  public update(_dt: number): void {
    throw new Error('Method not implemented.');
  }

  public debugInMenu(): void {
    // Implement debug menu if needed
  }

  public renderDebug(): void {
    // Implement debug rendering if needed
  }
}
