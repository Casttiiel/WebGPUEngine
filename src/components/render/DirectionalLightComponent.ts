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
import { DirectionalLightComponentData } from '../../types/DirectionalLightComponentData.type';

interface AABB {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
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
  private cascadeSplits: number[] = []; // Split distances (calculadas dinámicamente)
  private cascadeLambda: number = 0.5; // 0=uniform, 1=logarithmic
  private maxShadowDistance: number = 50.0; // Distancia máxima de sombras (no usar full frustum)
  private mainCamera!: Camera; // Referencia a la cámara principal

  constructor() {
    super();
  }

  public async load(lightData: DirectionalLightComponentData): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    // Configurar CSM
    this.cascadeCount = Math.min(3, Math.max(1, lightData.cascadeCount || 1));
    this.cascadeLambda = lightData.cascadeLambda ?? 0.5; // 0=uniforme, 1=logarítmico
    this.maxShadowDistance = lightData.maxShadowDistance ?? 50.0; // Limitar sombras a 50m por defecto

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

    for (let i = 0; i < this.cascadeCount; i++) {
      const camera = new Camera();

      // Se configurará dinámicamente en updateShadowCameras()
      // basado en el frustum de la cámara principal
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
   * Calcula las distancias de split para las cascadas usando interpolación logarítmica.
   * Lambda = 0: división uniforme
   * Lambda = 1: división logarítmica
   * Lambda = 0.5: híbrido (recomendado)
   */
  private calculateCascadeSplits(near: number, far: number): number[] {
    const splits: number[] = [];

    for (let i = 1; i <= this.cascadeCount; i++) {
      const ratio = i / this.cascadeCount;

      // Split uniforme
      const uniform = near + (far - near) * ratio;

      // Split logarítmico
      const logarithmic = near * Math.pow(far / near, ratio);

      // Interpolación entre uniforme y logarítmico
      const split = this.cascadeLambda * logarithmic + (1 - this.cascadeLambda) * uniform;
      splits.push(split);
    }

    return splits;
  }

  /**
   * Extrae los 8 corners de un frustum entre near y far en world space.
   */
  private extractFrustumCorners(camera: Camera, nearDist: number, farDist: number): vec3[] {
    const corners: vec3[] = [];

    // Obtener inverse view-projection
    const invViewProj = camera.getInvViewProjectionMatrix();

    // 8 corners en NDC space (normalized device coordinates)
    const ndcCorners = [
      [-1, -1, 0], // near bottom-left
      [1, -1, 0], // near bottom-right
      [1, 1, 0], // near top-right
      [-1, 1, 0], // near top-left
      [-1, -1, 1], // far bottom-left
      [1, -1, 1], // far bottom-right
      [1, 1, 1], // far top-right
      [-1, 1, 1], // far top-left
    ];

    // Transformar de NDC a world space
    for (const ndc of ndcCorners) {
      const worldCorner = vec3.create();
      const ndcVec4 = [ndc[0], ndc[1], ndc[2], 1.0];

      // Transformar a world space
      const worldVec4 = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          worldVec4[i] += invViewProj[j * 4 + i] * ndcVec4[j];
        }
      }

      // Perspective divide
      worldCorner[0] = worldVec4[0] / worldVec4[3];
      worldCorner[1] = worldVec4[1] / worldVec4[3];
      worldCorner[2] = worldVec4[2] / worldVec4[3];

      corners.push(worldCorner);
    }

    // Ajustar corners según las distancias near/far específicas
    const cameraPos = camera.getCameraPosition();
    const cameraDir = camera.getFront();

    const originalNear = camera.getNear();
    const originalFar = camera.getFar();

    // Escalar corners del near plane
    const nearScale = nearDist / originalNear;
    for (let i = 0; i < 4; i++) {
      const dir = vec3.create();
      vec3.subtract(dir, corners[i], cameraPos);
      vec3.scale(dir, dir, nearScale);
      vec3.add(corners[i], cameraPos, dir);
    }

    // Escalar corners del far plane
    const farScale = farDist / originalFar;
    for (let i = 4; i < 8; i++) {
      const dir = vec3.create();
      vec3.subtract(dir, corners[i], cameraPos);
      vec3.scale(dir, dir, farScale);
      vec3.add(corners[i], cameraPos, dir);
    }

    return corners;
  }

  /**
   * Calcula el AABB en light space de un conjunto de corners.
   */
  private calculateAABBInLightSpace(corners: vec3[], lightView: mat4): AABB {
    const aabb: AABB = {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity,
    };

    // Transformar cada corner a light space y expandir AABB
    for (const corner of corners) {
      const lightSpaceCorner = vec3.create();
      vec3.transformMat4(lightSpaceCorner, corner, lightView);

      aabb.minX = Math.min(aabb.minX, lightSpaceCorner[0]);
      aabb.maxX = Math.max(aabb.maxX, lightSpaceCorner[0]);
      aabb.minY = Math.min(aabb.minY, lightSpaceCorner[1]);
      aabb.maxY = Math.max(aabb.maxY, lightSpaceCorner[1]);
      aabb.minZ = Math.min(aabb.minZ, lightSpaceCorner[2]);
      aabb.maxZ = Math.max(aabb.maxZ, lightSpaceCorner[2]);
    }

    return aabb;
  }

  /**
   * Actualiza las shadow cameras basándose en el frustum de la cámara principal.
   * Calcula los splits, extrae los corners, y configura cada cascade con tight-fitting AABB.
   */
  private updateShadowCameras(mainCamera: Camera): void {
    this.mainCamera = mainCamera;

    // 1. Calcular split distances basados en maxShadowDistance (NO full frustum)
    const near = mainCamera.getNear();
    const far = Math.min(this.maxShadowDistance, mainCamera.getFar()); // ⚠️ Limitar a maxShadowDistance
    this.cascadeSplits = this.calculateCascadeSplits(near, far);

    // 2. Calcular light view matrix (mismo para todas las cascadas)
    const lightView = mat4.create();
    const lightPos = vec3.create();
    const lightTarget = vec3.create();
    const lightUp = vec3.fromValues(0, 0, 1); // Perpendicular a la dirección de la luz

    // Posicionar la luz "mirando" en la dirección de la luz
    vec3.set(lightPos, 0, 0, 0);
    vec3.add(lightTarget, lightPos, this.lightDirection);
    mat4.lookAt(lightView, lightPos, lightTarget, lightUp);

    // 3. Configurar cada cascada
    let prevSplit = near;

    for (let i = 0; i < this.cascadeCount; i++) {
      const currentSplit = this.cascadeSplits[i];

      // 3.1. Extraer los 8 corners del sub-frustum
      const frustumCorners = this.extractFrustumCorners(mainCamera, prevSplit, currentSplit);

      // 3.2. Calcular AABB en light space
      let aabb = this.calculateAABBInLightSpace(frustumCorners, lightView);

      // 3.3. Extensión adaptativa del AABB
      const cascadeSize = Math.sqrt(
        Math.pow(aabb.maxX - aabb.minX, 2) +
          Math.pow(aabb.maxY - aabb.minY, 2) +
          Math.pow(aabb.maxZ - aabb.minZ, 2),
      );

      // Más extensión para cascades lejanas (tienen menos resolución anyway)
      const extensionFactor = 0.3 + i * 0.1;
      const margin = cascadeSize * extensionFactor;

      // ⚠️ CRÍTICO: Triple extensión en Z (hacia la luz) para capturar shadow casters detrás
      aabb.minZ -= margin * 3.0;
      aabb.maxZ += margin * 0.5; // Poca extensión adelante

      // Extensión lateral moderada
      const lateralMargin = margin * 1.5;
      aabb.minX -= lateralMargin;
      aabb.maxX += lateralMargin;
      aabb.minY -= lateralMargin;
      aabb.maxY += lateralMargin;

      // 3.4. Configurar la shadow camera para esta cascade
      const shadowCamera = this.shadowCameras[i];

      // Near/Far planes basados en el AABB extendido
      shadowCamera.setNearPlane(aabb.minZ);
      shadowCamera.setFarPlane(aabb.maxZ);

      // Ortho bounds basados en el AABB
      const orthoWidth = aabb.maxX - aabb.minX;
      const orthoHeight = aabb.maxY - aabb.minY;
      shadowCamera.setOrthoParams(true, 0, orthoWidth, 0, orthoHeight);

      // Calcular el centro del AABB en light space
      const aabbCenter = vec3.fromValues(
        (aabb.minX + aabb.maxX) * 0.5,
        (aabb.minY + aabb.maxY) * 0.5,
        (aabb.minZ + aabb.maxZ) * 0.5,
      );

      // Transformar el centro de vuelta a world space
      const invLightView = mat4.create();
      mat4.invert(invLightView, lightView);
      const worldCenter = vec3.create();
      vec3.transformMat4(worldCenter, aabbCenter, invLightView);

      // Posicionar la shadow camera en el centro del AABB (en world space)
      // La cámara mira en la dirección de la luz
      const shadowCameraPos = vec3.create();
      vec3.scaleAndAdd(shadowCameraPos, worldCenter, this.lightDirection, -aabb.maxZ);

      const shadowTarget = vec3.create();
      vec3.add(shadowTarget, shadowCameraPos, this.lightDirection);

      // Texel snapping para eliminar shimmer
      this.snapToTexelGrid(shadowCameraPos, i);

      // Actualizar shadow camera
      shadowCamera.lookAt(shadowCameraPos, shadowTarget, lightUp);
      shadowCamera.updateUniforms();

      prevSplit = currentSplit;
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
      // Obtener la cámara principal del render module
      const mainCameraEntity = Engine.getEntities().getEntityByName('MainCamera');
      if (mainCameraEntity && mainCameraEntity.hasComponent('camera')) {
        const cameraComponent = mainCameraEntity.getComponent('camera');
        const mainCamera = (cameraComponent as any).getCamera(); // CameraComponent tiene getCamera()

        if (mainCamera) {
          // Actualizar shadow cameras basadas en el frustum de la cámara principal
          this.updateShadowCameras(mainCamera);
        }
      }
    }

    // Actualizar uniforms con las nuevas posiciones
    this.updateLightUniforms();
  }

  public override renderDebug(): void {}
}
