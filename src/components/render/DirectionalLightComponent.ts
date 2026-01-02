import { Engine } from '../../core/engine/Engine';
import { Render } from '../../renderer/core/pipeline/Render';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { RenderManagerV2 as RenderManager } from '../../renderer/core/managers/RenderManagerV2';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { Camera } from '../../core/math/Camera';
import { mat4, vec3 } from 'gl-matrix';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { Component } from '../../core/ecs/Component';
import { TransformComponent } from '../core/TransformComponent';

interface DirectionalLightData {
  near?: number;
  far?: number;
  orthoWidth?: number;
  orthoHeight?: number;
  hasShadows?: boolean;
  color?: number[];
  intensity?: number;
  position: number[];
  target: number[];
  // CSM configuration
  cascadeCount?: number; // 1, 2, or 3 cascades (default: 1)
  cascadeSplits?: number[]; // [5.0, 15.0, 50.0] for 3 cascades
  cascadeOrthoSizes?: number[]; // [10, 20, 40] ortho sizes per cascade
  cascadeDistances?: number[]; // [15, 25, 40] camera distances per cascade
}

export class DirectionalLightComponent extends Component {
  private fullscreenQuadMesh!: Mesh;
  private directionalLightTechnique!: Technique;
  private directionalLightBindGroup!: GPUBindGroup;
  private uniformBuffer!: GPUBuffer;
  private shadowDepthTextures!: GPUTexture[]; // Una por cascada
  private shadowDepthViews!: GPUTextureView[]; // Una por cascada
  private shadowSampler!: GPUSampler;
  private shadowCameras!: Camera[]; // Una por cascada
  private hasShadows!: boolean;
  private color!: number[];
  private intensity!: number;
  private lightDirection!: vec3; // Dirección de la luz (normalizada)

  // CSM configuration
  private cascadeCount: number = 1; // Number of cascades (1-3)
  private cascadeSplits!: number[]; // Split distances
  private cascadeOrthoSizes!: number[]; // Ortho sizes per cascade
  private cascadeDistances!: number[]; // Camera distances per cascade

  constructor() {
    super();
  }

  public async load(lightData: DirectionalLightData): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    // Configurar CSM
    this.cascadeCount = Math.min(3, Math.max(1, lightData.cascadeCount || 1));
    this.cascadeSplits = lightData.cascadeSplits || [5.0, 10.0, 15.0];
    this.cascadeOrthoSizes = lightData.cascadeOrthoSizes || [10, 15, 20];
    this.cascadeDistances = lightData.cascadeDistances || [25, 25, 25];

    // Cargar técnica apropiada (CSM o single shadow)
    const techniquePath =
      this.cascadeCount > 1 ? 'directional_light_csm.tech' : 'directional_light.tech';
    this.directionalLightTechnique = await Technique.getAsync(techniquePath);

    // Uniform buffer size: base (32 bytes) + 3 cascadas * 64 bytes (mat4x4) + cascadeSplits (16) + shadow params (16)
    const uniformBufferSize = 32 + 3 * 64 + 16 + 16;
    this.uniformBuffer = GPUUtils.createBuffer(
      'directional light uniform buffer',
      uniformBufferSize,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Crear texturas de profundidad para shadow mapping (una por cascada)
    this.shadowDepthTextures = [];
    this.shadowDepthViews = [];
    const shadowResolution =
      QualitySettings.getInstance().getSettings().directionalShadowMapResolution;

    for (let i = 0; i < this.cascadeCount; i++) {
      const shadowTexture = GPUUtils.createTexture(
        `directional_light_shadow_depth_map_cascade_${i}`,
        shadowResolution,
        shadowResolution,
        'depth32float',
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      );
      this.shadowDepthTextures.push(shadowTexture);
      this.shadowDepthViews.push(shadowTexture.createView({ aspect: 'depth-only' }));
    }

    // Crear sampler de comparación para shadow mapping
    this.shadowSampler = SamplerLibrary.shadows;

    // Crear bind group apropiado según el número de cascadas
    let bindGroupEntries: GPUBindGroupEntry[];

    if (this.cascadeCount > 1) {
      // CSM: 3 shadow maps + sampler
      bindGroupEntries = [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
        {
          binding: 1,
          resource: this.shadowDepthViews[0],
        },
        {
          binding: 2,
          resource: this.shadowDepthViews[Math.min(1, this.cascadeCount - 1)],
        },
        {
          binding: 3,
          resource: this.shadowDepthViews[Math.min(2, this.cascadeCount - 1)],
        },
        {
          binding: 4,
          resource: this.shadowSampler,
        },
      ];
    } else {
      // Single shadow map: 1 shadow map + sampler
      bindGroupEntries = [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
        {
          binding: 1,
          resource: this.shadowDepthViews[0],
        },
        {
          binding: 2,
          resource: this.shadowSampler,
        },
      ];
    }

    this.directionalLightBindGroup = BindGroupFactory.createBindGroup(
      `directional_light_bindgroup`,
      this.directionalLightTechnique.getPipeline().getBindGroupLayout(2)!,
      bindGroupEntries,
    );

    // Crear shadow cameras (una por cascada)
    this.shadowCameras = [];

    // Near/Far IGUALES para todas las cascadas (crucial para consistencia de sombras)
    const shadowNear = lightData.near || 0.1;
    const shadowFar = lightData.far || 100.0;

    for (let i = 0; i < this.cascadeCount; i++) {
      const camera = new Camera();

      // Mismo near/far para TODAS las cascadas
      camera.setNearPlane(shadowNear);
      camera.setFarPlane(shadowFar);

      // Solo cambia el ortho size (área que cubre)
      camera.setOrthoParams(true, 0, this.cascadeOrthoSizes[i], 0, this.cascadeOrthoSizes[i]);

      // Configuración inicial (se actualizará en update())
      camera.lookAt(lightData.position, lightData.target, [0, 0, 1]);
      camera.updateUniforms();

      this.shadowCameras.push(camera);
    }

    // Calcular y guardar la dirección de la luz (normalizada)
    const initialDir = vec3.create();
    vec3.subtract(initialDir, lightData.target, lightData.position);
    vec3.normalize(initialDir, initialDir);
    this.lightDirection = initialDir;

    this.hasShadows = lightData.hasShadows ?? false;
    this.color = lightData.color ?? [1.0, 1.0, 1.0];
    this.intensity = lightData.intensity ?? 1.0;

    this.updateLightUniforms();
  }

  /**
   * Actualiza la posición de las shadow cameras para seguir al jugador.
   * La dirección de la luz permanece constante, pero las cámaras se mueven
   * para mantener al jugador centrado en los shadow maps.
   */
  private updateShadowCameras(playerPos: vec3): void {
    const negLightDir = vec3.create();
    vec3.negate(negLightDir, this.lightDirection);

    // TODAS las shadow cameras a la misma distancia del jugador
    // Solo cambia el ortho size de cada una
    const shadowCameraDistance = 30.0; // Distancia fija para todas las cascadas

    // Actualizar cada cascada
    for (let i = 0; i < this.cascadeCount; i++) {
      // 1. Posicionar shadow camera detrás del jugador (MISMA posición para todas)
      const shadowCameraPos = vec3.create();
      vec3.scaleAndAdd(shadowCameraPos, playerPos, negLightDir, shadowCameraDistance);

      // 2. La shadow camera mira hacia el jugador
      const targetPos = vec3.clone(playerPos);

      // 3. Snap a texel grid para eliminar shadow shimmer
      this.snapToTexelGrid(shadowCameraPos, i);

      // 4. Actualizar shadow camera
      this.shadowCameras[i].lookAt(shadowCameraPos, targetPos, [0, 0, 1]);
      this.shadowCameras[i].updateUniforms();
    }
  }

  /**
   * Ajusta una posición a un grid de texels para eliminar el "shadow shimmer"
   * cuando la cámara se mueve.
   */
  private snapToTexelGrid(position: vec3, cascadeIndex: number): void {
    const shadowMapResolution =
      QualitySettings.getInstance().getSettings().directionalShadowMapResolution;
    const orthoSize = this.shadowCameras[cascadeIndex].getOrthoWidth();
    const worldUnitsPerTexel = orthoSize / shadowMapResolution;

    // Snap posición a múltiplos de worldUnitsPerTexel
    position[0] = Math.floor(position[0] / worldUnitsPerTexel) * worldUnitsPerTexel;
    position[1] = Math.floor(position[1] / worldUnitsPerTexel) * worldUnitsPerTexel;
    position[2] = Math.floor(position[2] / worldUnitsPerTexel) * worldUnitsPerTexel;
  }

  private updateLightUniforms(): void {
    // color (vec4) - bytes 0-15
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      0,
      new Float32Array([this.color[0], this.color[1], this.color[2], this.hasShadows ? 1.0 : 0.0]),
    );

    // Para luz direccional: la dirección debe ser HACIA la fuente de luz
    const cameraDirection = this.shadowCameras[0].getFront();
    const lightDirection = vec3.fromValues(
      -cameraDirection[0],
      -cameraDirection[1],
      -cameraDirection[2],
    );

    // position (vec3) + intensity (f32) - bytes 16-31
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      16,
      new Float32Array([lightDirection[0], lightDirection[1], lightDirection[2], this.intensity]),
    );

    // Crear matrices de transformación para cada cascada (bytes 32-223)
    const mtx_scale = mat4.create();
    const mtx_translation = mat4.create();
    const mtx_offset = mat4.create();

    mat4.scale(mtx_scale, mat4.create(), [0.5, -0.5, 1.0]);
    mat4.translate(mtx_translation, mat4.create(), [0.5, 0.5, 0.0]);
    mat4.multiply(mtx_offset, mtx_translation, mtx_scale);

    // Escribir matrices para 3 cascadas (aunque solo usemos 1-3)
    for (let i = 0; i < 3; i++) {
      const lightViewProjOffset = mat4.create();
      const cascadeIndex = Math.min(i, this.cascadeCount - 1);
      mat4.multiply(
        lightViewProjOffset,
        mtx_offset,
        this.shadowCameras[cascadeIndex].getViewProjection(),
      );
      GPUUtils.writeBuffer(this.uniformBuffer, 32 + i * 64, new Float32Array(lightViewProjOffset));
    }

    // cascadeSplits (vec4) - bytes 224-239
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      224,
      new Float32Array([
        this.cascadeSplits[0] || 5.0,
        this.cascadeSplits[1] || 15.0,
        this.cascadeSplits[2] || 50.0,
        this.cascadeCount,
      ]),
    );

    // Shadow parameters - bytes 240-255
    const shadowStep = 2.0;
    const shadowInverseResolution =
      1.0 / QualitySettings.getInstance().getSettings().directionalShadowMapResolution;
    const shadowStepDivResolution =
      shadowStep / QualitySettings.getInstance().getSettings().directionalShadowMapResolution;

    GPUUtils.writeBuffer(
      this.uniformBuffer,
      240,
      new Float32Array([shadowStep, shadowInverseResolution, shadowStepDivResolution, 0.0]),
    );
  }

  public generateShadowMap(): void {
    const render = Render.getInstance();
    const shadowResolution =
      QualitySettings.getInstance().getSettings().directionalShadowMapResolution;

    // Renderizar cada cascada
    for (let i = 0; i < this.cascadeCount; i++) {
      // Culling para esta cascada
      RenderManager.getInstance().performCulling(this.shadowCameras[i], RenderCategory.SHADOWS);

      // Crear render pass para esta cascada
      const depthStencilAttachment = GPUUtils.createDepthStencilAttachment(
        this.shadowDepthViews[i],
      );

      const pass = render.getCommandEncoder().beginRenderPass(
        GPUUtils.createRenderPassDescriptor(
          `directional light shadow map cascade ${i}`,
          [], // Sin color attachments
          depthStencilAttachment,
        ),
      );

      GPUUtils.configureViewportAndScissor(pass, shadowResolution, shadowResolution);

      // Usar la cámara de esta cascada
      RenderManager.getInstance().setCamera(this.shadowCameras[i]);

      // Renderizar objetos con sombras
      RenderManager.getInstance().render(RenderCategory.SHADOWS, pass);

      pass.end();
    }
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

  public override update(dt: number): void {
    if (this.hasShadows) {
      // Obtener la cámara principal (jugador)
      const playerEntity = Engine.getEntities().getEntityByName('Player');
      if (playerEntity) {
        const transformComponent = playerEntity.getComponent('transform') as TransformComponent;
        if (transformComponent) {
          const playerPos = transformComponent.getTransform().getWorldPosition();

          // Actualizar posición de las shadow cameras para seguir al jugador
          this.updateShadowCameras(playerPos);
        }
      }
    }

    // Actualizar uniforms con las nuevas posiciones
    this.updateLightUniforms();
  }

  public override renderDebug(): void {}
}
