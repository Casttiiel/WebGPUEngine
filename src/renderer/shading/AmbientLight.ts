import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/Render';
import { Cubemap } from '../resources/Cubemap';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { Texture } from '../resources/Texture';

export class AmbientLight {
  private fullscreenQuadMesh!: Mesh;
  private whiteTexture!: Texture;
  private environmentTexture!: Cubemap;
  private irradianceTexture!: Cubemap;
  private brdfLUTTexture!: Texture;

  private ambientTechnique!: Technique;
  private gBufferBindGroup!: GPUBindGroup;
  private environmentBindGroup!: GPUBindGroup;
  private uniformBindGroup!: GPUBindGroup;
  private ambientUniformBuffer!: GPUBuffer;

  private reflectionIntensity = 0.3;
  private ambientLightIntensity = 0.7;
  private globalAmbientBoost = 0.4;

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
    this.irradianceTexture = await Cubemap.get('irradiance.png');
    this.brdfLUTTexture = await Texture.get('brdfLUT.png');

    this.environmentBindGroup = Render.getInstance()
      .getDevice()
      .createBindGroup({
        label: `environment_with_brdf_bindgroup`,
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
          {
            binding: 2,
            resource: this.brdfLUTTexture.getTextureView(),
          },
          {
            binding: 3,
            resource: this.brdfLUTTexture.getSampler(),
          },
          {
            binding: 4,
            resource: this.irradianceTexture.getTextureView(),
          },
          {
            binding: 5,
            resource: this.irradianceTexture.getSampler(),
          },
        ],
      });

    this.ambientUniformBuffer = Render.getInstance()
      .getDevice()
      .createBuffer({
        label: `ambient uniform buffer`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

    this.uniformBindGroup = Render.getInstance()
      .getDevice()
      .createBindGroup({
        label: `ambient light uniform bind group`,
        layout: this.ambientTechnique.getPipeline().getBindGroupLayout(3),
        entries: [
          {
            binding: 0,
            resource: { buffer: this.ambientUniformBuffer },
          },
        ],
      });
  }

  public render(rtAccLight: GPUTextureView): void {
    const render = Render.getInstance();
    render
      .getDevice()
      .queue.writeBuffer(
        this.ambientUniformBuffer,
        0,
        new Float32Array([
          this.reflectionIntensity,
          this.ambientLightIntensity,
          this.globalAmbientBoost,
          0.0,
        ]),
      );
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
    pass.setBindGroup(3, this.uniformBindGroup); // ambient parameters

    // 4. Dibujar la mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  public update(dt: number): void {}
}
