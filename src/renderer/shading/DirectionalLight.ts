import { Engine } from '../../core/engine/Engine';
import { Render } from '../core/pipeline/Render';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { RenderManagerV2 as RenderManager } from '../../renderer/core/managers/RenderManagerV2';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { Camera } from '../../core/math/Camera';
import { mat4, vec3 } from 'gl-matrix';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { QualitySettings } from '../../core/engine/QualitySettings';

export class DirectionalLight {
  private fullscreenQuadMesh!: Mesh;
  private directionalLightTechnique!: Technique;
  private directionalLightBindGroup!: GPUBindGroup;
  private uniformBuffer!: GPUBuffer;
  private shadowDepthTexture!: GPUTexture;
  private shadowDepthView!: GPUTextureView;
  private shadowSampler!: GPUSampler;
  private camera!: Camera;
  private shadowsDirty: boolean = true;

  constructor() {}

  public async load(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.directionalLightTechnique = await Technique.get('directional_light.tech');

    this.uniformBuffer = GPUUtils.createBuffer(
      'directional light uniform buffer',
      36 * 4,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Crear textura de profundidad para shadow mapping
    this.shadowDepthTexture = GPUUtils.createTexture(
      'directional_light_shadow_depth_map',
      QualitySettings.getInstance().getSettings().directionalShadowMapResolution,
      QualitySettings.getInstance().getSettings().directionalShadowMapResolution,
      'depth32float',
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    );

    this.shadowDepthView = this.shadowDepthTexture.createView({
      aspect: 'depth-only',
    });

    // Crear sampler de comparación para shadow mapping
    this.shadowSampler = SamplerLibrary.shadows;

    this.directionalLightBindGroup = BindGroupFactory.createBindGroup(
      `directional_light_bindgroup`,
      this.directionalLightTechnique.getPipeline().getBindGroupLayout(2)!,
      [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
        {
          binding: 1,
          resource: this.shadowDepthView, // Textura de profundidad
        },
        {
          binding: 2,
          resource: this.shadowSampler, // Sampler de comparación
        },
      ],
    );

    this.camera = new Camera();
    this.camera.setNearPlane(0.1);
    this.camera.setFarPlane(100.0);
    this.camera.setOrthoParams(true, 0, 20, 0, 20);
    this.camera.lookAt([0.0, 15.0, 0.0], [-3.0, 0.0, 3.0]);
    this.camera.updateUniforms();

    this.updateLightUniforms();
  }

  private updateLightUniforms(): void {
    // color (vec4) - bytes 0-15
    GPUUtils.writeBuffer(this.uniformBuffer, 0, new Float32Array([1.0, 0.956, 0.878, 1.0]));

    // Para luz direccional: la dirección debe ser HACIA la fuente de luz
    // Si la cámara mira hacia abajo [0, -1, 0], la luz viene de arriba [0, 1, 0]
    const cameraDirection = this.camera.getFront();
    const lightDirection = vec3.fromValues(
      -cameraDirection[0],
      -cameraDirection[1],
      -cameraDirection[2],
    );

    // position (vec3) + intensity (f32) - bytes 16-31
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      16,
      new Float32Array([lightDirection[0], lightDirection[1], lightDirection[2], 10.0]),
    );

    // Crear matriz de transformación de clip space a UV space
    const mtx_scale = mat4.create();
    const mtx_translation = mat4.create();
    const mtx_offset = mat4.create();
    const lightViewProjOffset = mat4.create();

    // CORRECCIÓN: Escalar de [-1,1] a [0,1] y aplicar offset
    mat4.scale(mtx_scale, mat4.create(), [0.5, -0.5, 1.0]);
    mat4.translate(mtx_translation, mat4.create(), [0.5, 0.5, 0.0]);

    // CORRECCIÓN: Orden correcto de transformaciones
    // Primero escalar, luego trasladar: T * S (se lee de derecha a izquierda)
    mat4.multiply(mtx_offset, mtx_translation, mtx_scale);

    // CORRECCIÓN: ViewProjection PRIMERO, luego la transformación a UV
    // Orden: UV_Transform * ViewProjection * worldPos
    mat4.multiply(lightViewProjOffset, mtx_offset, this.camera.getViewProjection());

    // Escribir la matriz lightViewProjOffset completa (NO solo ViewProjection)
    GPUUtils.writeBuffer(this.uniformBuffer, 32, new Float32Array(lightViewProjOffset)); // radius (f32) - bytes 96-99 (no se usa para directional light)
    GPUUtils.writeBuffer(this.uniformBuffer, 96, new Float32Array([0.0]));

    // shadowStep (f32) - bytes 100-103
    const shadowStep = 2.0;
    GPUUtils.writeBuffer(this.uniformBuffer, 100, new Float32Array([shadowStep]));

    // shadowInverseResolution (f32) - bytes 104-107
    const shadowInverseResolution =
      1.0 / QualitySettings.getInstance().getSettings().directionalShadowMapResolution;
    GPUUtils.writeBuffer(this.uniformBuffer, 104, new Float32Array([shadowInverseResolution]));

    // shadowStepDivResolution (f32) - bytes 108-111
    const shadowStepDivResolution =
      shadowStep / QualitySettings.getInstance().getSettings().directionalShadowMapResolution;
    GPUUtils.writeBuffer(this.uniformBuffer, 108, new Float32Array([shadowStepDivResolution]));

    // startFalloff (f32) - bytes 112-115 (no se usa para directional light)
    GPUUtils.writeBuffer(this.uniformBuffer, 112, new Float32Array([0.0]));

    // padding (vec3) - bytes 116-127
    GPUUtils.writeBuffer(this.uniformBuffer, 116, new Float32Array([0.0, 0.0, 0.0]));

    // extraPadding (f32) - bytes 128-131
    GPUUtils.writeBuffer(this.uniformBuffer, 128, new Float32Array([0.0]));
  }

  public renderShadowMap(): void {
    if (!this.shadowsDirty) {
      return;
    }

    RenderManager.getInstance().performCulling(this.camera, RenderCategory.SHADOWS);
    const render = Render.getInstance();

    // Solo renderizar a la textura de profundidad (sin color attachment)
    const depthStencilAttachment = GPUUtils.createDepthStencilAttachment(this.shadowDepthView!);

    const pass = render.getCommandEncoder().beginRenderPass(
      GPUUtils.createRenderPassDescriptor(
        'directional light shadow map render pass',
        [], // Sin color attachments
        depthStencilAttachment,
      ),
    );
    GPUUtils.configureViewportAndScissor(
      pass,
      QualitySettings.getInstance().getSettings().directionalShadowMapResolution,
      QualitySettings.getInstance().getSettings().directionalShadowMapResolution,
    ); // Usar resolución de shadow map

    RenderManager.getInstance().setCamera(this.camera);

    RenderManager.getInstance().render(RenderCategory.SHADOWS, pass);

    pass.end();

    this.shadowsDirty = false;
  }

  public render(rtAccLight: GPUTextureView, gBufferBindGroup: GPUBindGroup): void {
    const render = Render.getInstance();

    // Use GPUUtils for consistent render pass descriptor creation
    const colorAttachment = GPUUtils.createColorAttachment(rtAccLight, 'load', 'store');

    const pass = render
      .getCommandEncoder()
      .beginRenderPass(
        GPUUtils.createRenderPassDescriptor('directional light render pass', [colorAttachment]),
      );

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(pass);

    // 1. Activate pipeline
    this.directionalLightTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, gBufferBindGroup);
    pass.setBindGroup(2, this.directionalLightBindGroup);

    // 4. Draw the mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }
}
