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

  // Shadow camera configuration
  private static readonly LIGHT_DISTANCE = 100.0; // Distancia fija CONSTANTE de la shadow camera

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
    // IMPORTANTE: Para luz direccional, la dirección es desde la FUENTE hacia el TARGET
    // position = donde está la fuente, target = hacia dónde apunta
    const initialDir = vec3.create();
    vec3.subtract(initialDir, lightData.target, lightData.position); // target - position
    vec3.normalize(initialDir, initialDir);
    this.lightDirection = initialDir; // Esta es la dirección HACIA donde va la luz

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
   * CORRECTO: Construye corners directamente en view space con nearDist/farDist.
   */
  private extractFrustumCorners(camera: Camera, nearDist: number, farDist: number): vec3[] {
    const corners: vec3[] = [];

    // Obtener matriz inversa de view
    const viewMatrix = camera.getView();
    const invView = mat4.create();
    mat4.invert(invView, viewMatrix);

    // Calcular corners en view space directamente con nearDist/farDist
    // IMPORTANTE: camera.getFov() devuelve FOV en RADIANES (no grados)
    const fovRadians = camera.getFov(); // FOV en radianes
    const tanHalfFov = Math.tan(fovRadians / 2.0); // Tangente del medio ángulo
    const aspect = camera.getAspectRatio();

    // Near plane corners en view space
    const nearHeight = 2.0 * tanHalfFov * nearDist;
    const nearWidth = nearHeight * aspect;

    // Far plane corners en view space
    const farHeight = 2.0 * tanHalfFov * farDist;
    const farWidth = farHeight * aspect;

    // 8 corners en view space (cámara mira hacia -Z)
    const viewCorners = [
      // Near plane
      vec3.fromValues(-nearWidth * 0.5, -nearHeight * 0.5, -nearDist),
      vec3.fromValues(nearWidth * 0.5, -nearHeight * 0.5, -nearDist),
      vec3.fromValues(nearWidth * 0.5, nearHeight * 0.5, -nearDist),
      vec3.fromValues(-nearWidth * 0.5, nearHeight * 0.5, -nearDist),
      // Far plane
      vec3.fromValues(-farWidth * 0.5, -farHeight * 0.5, -farDist),
      vec3.fromValues(farWidth * 0.5, -farHeight * 0.5, -farDist),
      vec3.fromValues(farWidth * 0.5, farHeight * 0.5, -farDist),
      vec3.fromValues(-farWidth * 0.5, farHeight * 0.5, -farDist),
    ];

    // Transformar de view space a world space
    for (const viewCorner of viewCorners) {
      const worldCorner = vec3.create();
      vec3.transformMat4(worldCorner, viewCorner, invView);
      corners.push(worldCorner);
    }

    return corners;
  }

  /**
   * Calcula el AABB en light space de un conjunto de corners.
   * IMPORTANTE: Estabiliza el AABB redondeándolo a múltiplos de texel size.
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
   * Estabiliza el AABB snapeándolo a la grilla de texeles en light space.
   * CRÍTICO: Snapear min/max del AABB, NO el centro - esto es clave para estabilidad.
   * El tamaño NO debe cambiar, solo la posición debe moverse en incrementos discretos.
   */
  private stabilizeAABB(aabb: AABB): AABB {
    const shadowMapResolution =
      QualitySettings.getInstance().getSettings().directionalShadowMapResolution;

    // Calcular el tamaño actual del AABB (MANTENER CONSTANTE)
    const width = aabb.maxX - aabb.minX;
    const height = aabb.maxY - aabb.minY;

    // Calcular world units per texel (texel size en light space)
    const texelSizeX = width / shadowMapResolution;
    const texelSizeY = height / shadowMapResolution;

    // CRÍTICO: Snapear minX/minY a la grilla de texeles
    // Esto es lo que hacen los motores reales - no snapear el centro
    const snappedMinX = Math.floor(aabb.minX / texelSizeX) * texelSizeX;
    const snappedMinY = Math.floor(aabb.minY / texelSizeY) * texelSizeY;

    // Reconstruir AABB manteniendo el tamaño EXACTAMENTE igual
    const stabilized: AABB = {
      minX: snappedMinX,
      maxX: snappedMinX + width,
      minY: snappedMinY,
      maxY: snappedMinY + height,
      minZ: aabb.minZ, // Z no necesita snapping (es profundidad)
      maxZ: aabb.maxZ,
    };

    return stabilized;
  }

  /**
   * Actualiza las shadow cameras basándose en el frustum de la cámara principal.
   * Calcula los splits, extrae los corners, y configura cada cascade con tight-fitting AABB.
   */
  private updateShadowCameras(mainCamera: Camera): void {
    // 1. Calcular split distances basados en maxShadowDistance
    const near = mainCamera.getNear();
    const far = Math.min(this.maxShadowDistance, mainCamera.getFar());
    this.cascadeSplits = this.calculateCascadeSplits(near, far);

    // CRÍTICO: lightUp debe cambiar cuando la luz está casi vertical para evitar flips
    // Si lightDirection está casi paralelo a Z, usar Y como up vector
    const lightUp =
      Math.abs(this.lightDirection[2]) > 0.9 ? vec3.fromValues(0, 1, 0) : vec3.fromValues(0, 0, 1);

    // 2. Configurar cada cascada CON lightView centrado por slice
    let prevSplit = near;

    for (let i = 0; i < this.cascadeCount; i++) {
      const currentSplit = this.cascadeSplits[i];

      // 2.1. Extraer los 8 corners del sub-frustum en world space
      const frustumCorners = this.extractFrustumCorners(mainCamera, prevSplit, currentSplit);

      // 2.1b. Extender frustum corners en world space hacia atrás (dirección -lightDir)
      // Esto garantiza que capturamos shadow casters detrás del frustum
      // CRÍTICO: La extensión debe escalar con el tamaño del cascade
      const sliceDepth = currentSplit - prevSplit;
      const extensionDistance = sliceDepth * 1.5; // 150% de la profundidad del slice
      const extendedCorners = frustumCorners.map((corner) => {
        const extended = vec3.create();
        vec3.scaleAndAdd(extended, corner, this.lightDirection, -extensionDistance);
        return extended;
      });
      // Combinar corners originales + extendidos = 16 corners totales
      const allCorners = [...frustumCorners, ...extendedCorners];

      // 2.2. Calcular el centro del frustum slice en world space
      const worldCenter = vec3.create();
      for (const corner of frustumCorners) {
        vec3.add(worldCenter, worldCenter, corner);
      }
      vec3.scale(worldCenter, worldCenter, 1.0 / frustumCorners.length);

      // 2.3. Construir lightView con posición FINAL desde el principio
      // CRÍTICO: Usar distancia CONSTANTE GLOBAL - NO depende del slice ni del AABB
      // Esto garantiza estabilidad temporal completa
      const lightPos = vec3.create();
      vec3.scaleAndAdd(
        lightPos,
        worldCenter,
        this.lightDirection,
        -DirectionalLightComponent.LIGHT_DISTANCE,
      );
      const lightView = mat4.create();
      mat4.lookAt(lightView, lightPos, worldCenter, lightUp);

      // 2.4. Calcular AABB en light space usando TODOS los corners (originales + extendidos)
      // Este es el ÚNICO cálculo de AABB - no se recalcula después
      let aabb = this.calculateAABBInLightSpace(allCorners, lightView, i);

      // 2.5. Extensión lateral adicional (la extensión en Z ya está hecha en world space)
      const cascadeSize = Math.sqrt(
        Math.pow(aabb.maxX - aabb.minX, 2) + Math.pow(aabb.maxY - aabb.minY, 2),
      );

      const lateralMargin = cascadeSize * (0.1 + i * 0.05);
      aabb.minX -= lateralMargin;
      aabb.maxX += lateralMargin;
      aabb.minY -= lateralMargin;
      aabb.maxY += lateralMargin;

      // 2.6. ESTABILIZAR el AABB (snap a texel grid)
      aabb = this.stabilizeAABB(aabb);

      // 2.7. Configurar la shadow camera con el MISMO lightView usado para el AABB
      const shadowCamera = this.shadowCameras[i];

      // Dimensiones del AABB estabilizado
      const orthoWidth = aabb.maxX - aabb.minX;
      const orthoHeight = aabb.maxY - aabb.minY;

      // Near/Far: usar el rango del AABB en light space
      // Como la cámara está a 100m de distancia, aabb.minZ será el near y aabb.maxZ el far
      shadowCamera.setNearPlane(-aabb.maxZ);
      shadowCamera.setFarPlane(-aabb.minZ);

      // Ortho bounds: usar las dimensiones del AABB
      shadowCamera.setOrthoParams(true, 0, orthoWidth, 0, orthoHeight);

      // Actualizar shadow camera con la MISMA posición usada para calcular el AABB
      shadowCamera.lookAt(lightPos, worldCenter, lightUp);
      shadowCamera.updateUniforms();

      prevSplit = currentSplit;
    }
  }

  private updateLightUniforms(): void {
    // color (vec4) - bytes 0-15
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      0,
      new Float32Array([this.color[0], this.color[1], this.color[2], this.hasShadows ? 1.0 : 0.0]),
    );

    // Para luz direccional: usar la dirección CONSTANTE calculada en load()
    // this.lightDirection ya apunta hacia donde VA la luz (e.g., downward [0, -1, 0])
    // En el shader necesitamos la dirección HACIA la fuente (upward [0, 1, 0])
    const lightDirectionToSource = vec3.create();
    vec3.negate(lightDirectionToSource, this.lightDirection);

    // position (vec3) + intensity (f32) - bytes 16-31
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      16,
      new Float32Array([
        lightDirectionToSource[0],
        lightDirectionToSource[1],
        lightDirectionToSource[2],
        this.intensity,
      ]),
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
    // Si una cascade no existe, usar el último split (far)
    const lastSplit = this.cascadeSplits[this.cascadeCount - 1] || this.maxShadowDistance;
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      224,
      new Float32Array([
        this.cascadeSplits[0] || lastSplit,
        this.cascadeSplits[1] || lastSplit,
        this.cascadeSplits[2] || lastSplit,
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

  // Getters for volumetric lighting integration
  public getUniformBuffer(): GPUBuffer {
    return this.uniformBuffer;
  }

  public getShadowDepthView(cascadeIndex: number = 0): GPUTextureView {
    const index = Math.min(cascadeIndex, this.cascadeCount - 1);
    const view = this.shadowDepthViews[index];
    if (!view) {
      throw new Error(`Shadow depth view not found for cascade ${index}`);
    }
    return view;
  }

  public getShadowSampler(): GPUSampler {
    return this.shadowSampler;
  }

  public getHasShadows(): boolean {
    return this.hasShadows;
  }
}
