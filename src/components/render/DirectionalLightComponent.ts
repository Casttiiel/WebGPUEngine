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
import { Texture } from '../../renderer/resources/Texture';
import { CameraComponent } from './CameraComponent';
import { GPUProfiler } from '../../core/debug/GPUProfiler';
import { PhysicsDebugDrawer } from '../../renderer/debug/PhysicsDebugDrawer';

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
  public linkedToTimeOfDay: boolean = true;
  private projectorTexture!: Texture;
  private projectorTextureView!: GPUTextureView;

  // Contact shadows integration
  /** 1×1 white texture used as fallback when no ContactShadowsComponent is present. */
  private contactShadowFallbackView!: GPUTextureView;
  /** Separate bind group for secondary passes (water, probes) — always uses white CS. */
  private secondaryLightBindGroup!: GPUBindGroup;
  /** Cached layout for the light bind group — avoids getPipeline() calls after load. */
  private _lightBindGroupLayout!: GPUBindGroupLayout;
  /** Last CS view installed in directionalLightBindGroup (for change detection). */
  private lastContactShadowView!: GPUTextureView;

  // CSM configuration
  private cascadeCount: number = 1; // Number of cascades (1-3)
  private cascadeSplits: number[] = []; // Split distances (calculadas dinámicamente)
  private cascadeLambda: number = 0.5; // 0=uniform, 1=logarithmic
  private maxShadowDistance: number = 50.0; // Distancia máxima de sombras (no usar full frustum)

  private shadowFov: number = 0;
  private shadowAspect: number = 0;
  /** Camera/settings the current splits were computed for (recomputed when any changes). */
  private readonly splitsKey: number[] = [];

  // Shadow camera configuration
  private static readonly LIGHT_DISTANCE = 100.0; // Distancia fija CONSTANTE de la shadow camera
  /**
   * How far (world units) each cascade's depth range extends from the receivers
   * toward the light. Casters further away than this are clipped and their
   * shadows vanish (tall buildings, terrain, roofs high above a low camera).
   * depth32float keeps plenty of precision over this range.
   */
  private static readonly CASTER_DEPTH_EXTENSION = 500.0;

  constructor() {
    super();
  }

  public async load(lightData: DirectionalLightComponentData): Promise<void> {
    // Configurar CSM
    this.cascadeCount = Math.min(3, Math.max(1, lightData.cascadeCount || 1));
    this.cascadeLambda = lightData.cascadeLambda ?? 0.5; // 0=uniforme, 1=logarítmico
    this.maxShadowDistance = lightData.maxShadowDistance ?? 50.0; // Limitar sombras a 50m por defecto

    // Always use the CSM shader regardless of cascade count.
    // directional_light.fs has a different uniform struct layout that misreads
    // shadowStepDivResolution from inside the second cascade matrix (byte 108),
    // producing garbage kernel radius → banding.  The CSM shader handles
    // cascadeCount=1 correctly via the early-return path in getShadowFactorCSMBlended.
    const isPSX = QualitySettings.getInstance().getSettings().ditheringMode === 'psx';
    const techniquePath = isPSX
      ? 'lighting/directional_light_csm_psx.tech'
      : 'lighting/directional_light_csm.tech';

    // Load mesh, texture, and technique in parallel — none depend on each other
    [this.fullscreenQuadMesh, this.projectorTexture, this.directionalLightTechnique] =
      await Promise.all([
        Mesh.getAsync('fullscreenquad.obj'),
        Texture.getAsync(lightData.projector ? lightData.projector : 'white.png'),
        Technique.getAsync(techniquePath),
      ]);
    this.projectorTextureView = this.projectorTexture.getTextureView()!;

    // White 1×1 texture used as the contact shadow fallback (factor = 1.0 everywhere = no shadow)
    const contactShadowFallbackTexture = await Texture.getAsync('white.png');
    this.contactShadowFallbackView = contactShadowFallbackTexture.getTextureView()!;

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

    for (let i = 0; i < this.cascadeCount; i++) {
      const res = this.getCascadeResolution(i);
      const shadowTexture = GPUUtils.createTexture(
        `directional_light_shadow_depth_map_cascade_${i}`,
        res,
        res,
        'depth32float',
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      );
      this.shadowDepthTextures.push(shadowTexture);
      this.shadowDepthViews.push(shadowTexture.createView({ aspect: 'depth-only' }));
    }

    // Crear sampler de comparación para shadow mapping
    this.shadowSampler = SamplerLibrary.shadows;

    // Always use CSM bind group layout — single cascade re-uses view[0] for the
    // unused cascade slots so every path binds the same 7 entries.
    const v0 = this.shadowDepthViews[0]!;
    const bindGroupEntries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.uniformBuffer } },
      { binding: 1, resource: v0 },
      { binding: 2, resource: this.shadowDepthViews[Math.min(1, this.cascadeCount - 1)] ?? v0 },
      { binding: 3, resource: this.shadowDepthViews[Math.min(2, this.cascadeCount - 1)] ?? v0 },
      { binding: 4, resource: this.shadowSampler },
      { binding: 5, resource: this.contactShadowFallbackView },
      { binding: 6, resource: SamplerLibrary.simpleSampler },
    ];

    this.directionalLightBindGroup = BindGroupFactory.createBindGroup(
      `directional_light_bindgroup`,
      this.directionalLightTechnique.getPipeline().getBindGroupLayout(2)!,
      bindGroupEntries,
    );

    // Secondary bind group (water, probes) — always white CS, never rebuilt.
    this.secondaryLightBindGroup = this.directionalLightBindGroup;

    // Cache the layout so setContactShadowView() doesn't call getPipeline() every time.
    this._lightBindGroupLayout = this.directionalLightTechnique
      .getPipeline()
      .getBindGroupLayout(2)!;

    // Track the initial contact shadow view so the first real view triggers a rebuild
    this.lastContactShadowView = this.contactShadowFallbackView;

    // Crear shadow cameras (una por cascada)
    this.shadowCameras = [];

    for (let i = 0; i < this.cascadeCount; i++) {
      const camera = new Camera();

      // Se configurará dinámicamente en updateShadowCameras()
      // basado en el frustum de la cámara principal
      camera.lookAt(lightData.position, lightData.target, [0, 0, 1]);
      camera.updateUniforms(0);

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
   * Returns the shadow map resolution for the given cascade index.
   * Each cascade halves the resolution of the previous one (minimum 256).
   *   C0 = baseRes  (near — full quality)
   *   C1 = baseRes / 2
   *   C2 = baseRes / 4
   */
  private getCascadeResolution(cascadeIndex: number): number {
    const base = QualitySettings.getInstance().getSettings().directionalShadowMapResolution;
    return Math.max(256, base >> cascadeIndex);
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
  // Per-frame scratch for the cascade setup (runs every frame per cascade: no allocations)
  private readonly _frustumCorners: vec3[] = Array.from({ length: 8 }, () => vec3.create());
  private readonly _invView = mat4.create();
  private readonly _worldCenter = vec3.create();
  private readonly _lightPos = vec3.create();
  private readonly _lightView = mat4.create();
  private readonly _lightUp = vec3.create();

  private extractFrustumCorners(camera: Camera, nearDist: number, farDist: number): vec3[] {
    const corners = this._frustumCorners;

    // Obtener matriz inversa de view
    const viewMatrix = camera.getView();
    const invView = mat4.invert(this._invView, viewMatrix);

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

    // 8 corners en view space (cámara mira hacia -Z): near plane 0-3, far plane 4-7,
    // transformados a world space en los vectores reutilizables.
    const hw = [nearWidth * 0.5, farWidth * 0.5];
    const hh = [nearHeight * 0.5, farHeight * 0.5];
    const dist = [nearDist, farDist];
    const signs = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (let plane = 0; plane < 2; plane++) {
      for (let k = 0; k < 4; k++) {
        const out = corners[plane * 4 + k]!;
        vec3.set(out, signs[k]![0]! * hw[plane]!, signs[k]![1]! * hh[plane]!, -dist[plane]!);
        vec3.transformMat4(out, out, invView);
      }
    }

    return corners;
  }

  private updateShadowCameras(mainCamera: Camera): void {
    // Splits depend on the camera projection and the CSM settings. Recompute when
    // any of them change — previously they were frozen on first use, so a
    // reflection-probe capture (90° FOV, aspect 1) or a FOV change left the main
    // camera with wrongly sized cascades.
    const near = mainCamera.getNear();
    const far = Math.min(this.maxShadowDistance, mainCamera.getFar());
    const fov = mainCamera.getFov();
    const aspect = mainCamera.getAspectRatio();
    const key = this.splitsKey;
    if (
      key[0] !== near ||
      key[1] !== far ||
      key[2] !== fov ||
      key[3] !== aspect ||
      key[4] !== this.cascadeLambda ||
      key[5] !== this.cascadeCount
    ) {
      this.cascadeSplits = this.calculateCascadeSplits(near, far);
      this.shadowFov = fov;
      this.shadowAspect = aspect;
      key[0] = near;
      key[1] = far;
      key[2] = fov;
      key[3] = aspect;
      key[4] = this.cascadeLambda;
      key[5] = this.cascadeCount;
    }

    const lightUp =
      Math.abs(this.lightDirection[2]) > 0.9
        ? vec3.set(this._lightUp, 0, 1, 0)
        : vec3.set(this._lightUp, 0, 0, 1);

    let prevSplit = mainCamera.getNear();

    for (let i = 0; i < this.cascadeCount; i++) {
      const currentSplit = this.cascadeSplits[i];
      const shadowResolution = this.getCascadeResolution(i);

      // 1. Radio fijo geométrico — NO depende de world space, es constante entre frames
      const radius_raw = this.calculateCascadeRadius(
        this.shadowFov,
        this.shadowAspect,
        prevSplit,
        currentSplit,
      );

      // Redondear radio al texel más cercano para tamaño exactamente constante
      const texelSize_provisional = (radius_raw * 2.0) / shadowResolution;
      const radius = Math.ceil(radius_raw / texelSize_provisional) * texelSize_provisional;
      const texelSize = (radius * 2.0) / shadowResolution;

      // 2. Calcular worldCenter del frustum slice (solo para orientar la cámara)
      const frustumCorners = this.extractFrustumCorners(mainCamera, prevSplit, currentSplit);
      const worldCenter = vec3.set(this._worldCenter, 0, 0, 0);
      for (const corner of frustumCorners) {
        vec3.add(worldCenter, worldCenter, corner);
      }
      vec3.scale(worldCenter, worldCenter, 1.0 / frustumCorners.length);

      // 3. Construir lightView desde worldCenter
      const lightPos = this._lightPos;
      vec3.scaleAndAdd(
        lightPos,
        worldCenter,
        this.lightDirection,
        -DirectionalLightComponent.LIGHT_DISTANCE,
      );
      // setViewMatrix() copies, so one scratch matrix serves every cascade
      const lightView = mat4.lookAt(this._lightView, lightPos, worldCenter, lightUp);

      // 4. SNAP: modificar directamente los elementos de traslación de lightView
      // lightView[12] y [13] ya están en light space — no hay que transformar nada
      // Esto evita el ciclo invert→transformar→lookAt que destruye el snap
      lightView[12] = Math.floor(lightView[12] / texelSize) * texelSize;
      lightView[13] = Math.floor(lightView[13] / texelSize) * texelSize;
      // lightView[14] no se snapea — es profundidad Z

      // 5. Calcular near/far Z desde los corners + extensión para shadow casters
      const Z_EXTENSION = DirectionalLightComponent.CASTER_DEPTH_EXTENSION;
      // Light-space Z of each corner and of the corner pushed Z_EXTENSION toward the light
      // (only the view-space Z row of lightView is needed — no temporaries).
      const m = lightView;
      const dirZ =
        m[2] * this.lightDirection[0] + m[6] * this.lightDirection[1] + m[10] * this.lightDirection[2];

      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const corner of frustumCorners) {
        const z = m[2] * corner[0] + m[6] * corner[1] + m[10] * corner[2] + m[14];
        const zExt = z - Z_EXTENSION * dirZ;
        minZ = Math.min(minZ, z, zExt);
        maxZ = Math.max(maxZ, z, zExt);
      }

      // 6. Configurar shadow camera
      const shadowCamera = this.shadowCameras[i];
      if (!shadowCamera) continue;

      shadowCamera.setNearPlane(-maxZ);
      shadowCamera.setFarPlane(-minZ);
      shadowCamera.setOrthoParams(true, 0, radius * 2.0, 0, radius * 2.0);

      // Usar setViewMatrix — NO lookAt, para preservar el snap
      shadowCamera.setViewMatrix(lightView);
      shadowCamera.updateUniforms(0);

      prevSplit = currentSplit;
    }
  }

  private calculateCascadeRadius(
    fovRadians: number,
    aspect: number,
    nearSplit: number,
    farSplit: number,
  ): number {
    // Radio del círculo circunscrito al frustum slice
    // Calculado geométricamente, no desde corners en world space
    const tanHalfFov = Math.tan(fovRadians / 2.0);

    // Center del slice en view space (punto medio entre near y far)
    const sliceCenter = (nearSplit + farSplit) / 2.0;

    // Corner más lejano del far plane
    const farHeight = tanHalfFov * farSplit;
    const farWidth = farHeight * aspect;

    // Distancia desde el centro del slice al corner más lejano
    const cornerDist = Math.sqrt(
      farWidth * farWidth +
        farHeight * farHeight +
        (farSplit - sliceCenter) * (farSplit - sliceCenter),
    );

    // Comparar con distancia al near corner también
    const nearHeight = tanHalfFov * nearSplit;
    const nearWidth = nearHeight * aspect;
    const nearCornerDist = Math.sqrt(
      nearWidth * nearWidth +
        nearHeight * nearHeight +
        (nearSplit - sliceCenter) * (nearSplit - sliceCenter),
    );

    return Math.max(cornerDist, nearCornerDist);
  }

  /** CPU copy of the 256-byte light uniform block, filled in place and written once per frame. */
  private readonly _uniformData = new Float32Array(64);
  private readonly _cascadeMtx = mat4.create();
  /** UV remap applied to each cascade's view-projection: scale (0.5, -0.5, 1) then translate (0.5, 0.5, 0). */
  private static readonly SHADOW_UV_OFFSET = mat4.fromValues(
    0.5, 0, 0, 0,
    0, -0.5, 0, 0,
    0, 0, 1, 0,
    0.5, 0.5, 0, 1,
  );

  private updateLightUniforms(): void {
    const d = this._uniformData;

    // color (vec4) - bytes 0-15
    d[0] = this.color[0]!;
    d[1] = this.color[1]!;
    d[2] = this.color[2]!;
    d[3] = this.hasShadows ? 1.0 : 0.0;

    // position (vec3) + intensity (f32) - bytes 16-31
    // this.lightDirection apunta hacia donde VA la luz; el shader necesita la dirección HACIA la fuente
    d[4] = -this.lightDirection[0];
    d[5] = -this.lightDirection[1];
    d[6] = -this.lightDirection[2];
    d[7] = this.intensity;

    // Matrices de las 3 cascadas (aunque solo usemos 1-3) - bytes 32-223
    for (let i = 0; i < 3; i++) {
      const cascadeIndex = Math.min(i, this.cascadeCount - 1);
      mat4.multiply(
        this._cascadeMtx,
        DirectionalLightComponent.SHADOW_UV_OFFSET,
        this.shadowCameras[cascadeIndex].getViewProjection(),
      );
      d.set(this._cascadeMtx as Float32Array, 8 + i * 16);
    }

    // cascadeSplits (vec4) - bytes 224-239. Si una cascade no existe, usar el último split (far)
    const lastSplit = this.cascadeSplits[this.cascadeCount - 1] || this.maxShadowDistance;
    d[56] = this.cascadeSplits[0] || lastSplit;
    d[57] = this.cascadeSplits[1] || lastSplit;
    d[58] = this.cascadeSplits[2] || lastSplit;
    d[59] = this.cascadeCount;

    // Shadow parameters - bytes 240-255
    // x/y/z = stepDivRes per cascade (C0=R, C1=R/2, C2=R/4 → PCF step scaled accordingly), w = unused
    d[60] = 1.0 / this.getCascadeResolution(0);
    d[61] = 1.0 / this.getCascadeResolution(Math.min(1, this.cascadeCount - 1));
    d[62] = 1.0 / this.getCascadeResolution(Math.min(2, this.cascadeCount - 1));
    d[63] = 0.0;

    GPUUtils.writeBuffer(this.uniformBuffer, 0, d);
  }

  public generateShadowMap(): void {
    const render = Render.getInstance();

    // Renderizar cada cascada
    for (let i = 0; i < this.cascadeCount; i++) {
      const cascadeResolution = this.getCascadeResolution(i);
      RenderManager.getInstance().performCulling(this.shadowCameras[i], RenderCategory.SHADOWS);

      // Crear render pass para esta cascada
      const depthStencilAttachment = GPUUtils.createDepthStencilAttachment(
        this.shadowDepthViews[i],
      );

      const shadowDesc = GPUUtils.createRenderPassDescriptor(
        `directional light shadow map cascade ${i}`,
        [], // Sin color attachments
        depthStencilAttachment,
      );
      const shadowTs = GPUProfiler.getInstance().getTimestampWrites(`Directional Shadow ${i}`);
      if (shadowTs) shadowDesc.timestampWrites = shadowTs;
      const pass = render.getCommandEncoder().beginRenderPass(shadowDesc);

      GPUUtils.configureViewportAndScissor(pass, cascadeResolution, cascadeResolution);

      // Usar la cámara de esta cascada
      RenderManager.getInstance().setCamera(this.shadowCameras[i]);

      // Renderizar objetos con sombras
      RenderManager.getInstance().render(RenderCategory.SHADOWS, pass);

      pass.end();
    }
  }

  /**
   * Updates the contact shadow view in the primary bind group.
   * Called once from DeferredRenderer when the CS view becomes available or changes
   * (e.g. first load, window resize). Never called from the hot render path.
   */
  public setContactShadowView(contactShadowView: GPUTextureView): void {
    if (contactShadowView === this.lastContactShadowView) return;
    this.lastContactShadowView = contactShadowView;
    const v0 = this.shadowDepthViews[0]!;
    this.directionalLightBindGroup = BindGroupFactory.createBindGroup(
      'directional_light_bindgroup',
      this._lightBindGroupLayout,
      [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: v0 },
        { binding: 2, resource: this.shadowDepthViews[Math.min(1, this.cascadeCount - 1)] ?? v0 },
        { binding: 3, resource: this.shadowDepthViews[Math.min(2, this.cascadeCount - 1)] ?? v0 },
        { binding: 4, resource: this.shadowSampler },
        { binding: 5, resource: contactShadowView },
        { binding: 6, resource: SamplerLibrary.simpleSampler },
      ],
    );
  }

  public render(
    rtAccLight: GPUTextureView,
    gBufferBindGroup: GPUBindGroup,
    useSecondaryBindGroup: boolean = false,
  ): void {
    const bindGroup = useSecondaryBindGroup
      ? this.secondaryLightBindGroup
      : this.directionalLightBindGroup;

    const render = Render.getInstance();

    // Use GPUUtils for consistent render pass descriptor creation
    const colorAttachment = GPUUtils.createColorAttachment(rtAccLight, 'load', 'store');

    const dlDesc = GPUUtils.createRenderPassDescriptor('directional light render pass', [
      colorAttachment,
    ]);
    const dlTs = GPUProfiler.getInstance().getTimestampWrites('Directional Light');
    if (dlTs) dlDesc.timestampWrites = dlTs;
    const pass = render.getCommandEncoder().beginRenderPass(dlDesc);

    // Configure viewport and scissor using GPUUtils
    GPUUtils.configureViewportAndScissor(pass);

    // 1. Activate pipeline
    this.directionalLightTechnique.activatePipeline(pass);

    // 2. Activate mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Set bind groups
    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, gBufferBindGroup);
    pass.setBindGroup(2, bindGroup);

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
        const mainCamera = (cameraComponent as CameraComponent).getCamera(); // CameraComponent tiene getCamera()

        if (mainCamera) {
          // Actualizar shadow cameras basadas en el frustum de la cámara principal
          this.updateShadowCameras(mainCamera);
        }
      }
    }

    // Actualizar uniforms con las nuevas posiciones
    this.updateLightUniforms();
  }

  /**
   * Forces shadow camera update for an explicit camera (used by reflection probe capture).
   * Bypasses the EntityManager lookup so probe face cameras are used instead of MainCamera.
   */
  public updateShadowsForCamera(camera: Camera): void {
    if (!this.hasShadows) return;
    this.updateShadowCameras(camera);
    this.updateLightUniforms();
  }

  public getCascadeCameras(): Camera[] {
    return this.shadowCameras;
  }

  private static readonly CASCADE_COLORS: [number, number, number, number][] = [
    [0.0, 1.0, 1.0, 1.0],
    [1.0, 0.5, 0.0, 1.0],
    [1.0, 0.0, 1.0, 1.0],
    [0.0, 1.0, 0.0, 1.0],
  ];

  public override renderDebug(filter?: string): void {
    if (!filter || (filter !== 'all' && !filter.includes('lights'))) return;
    if (!this.shadowCameras?.length) return;
    const physicsDebug = PhysicsDebugDrawer.getInstance();
    for (let i = 0; i < this.shadowCameras.length; i++) {
      const col = DirectionalLightComponent.CASCADE_COLORS[i % DirectionalLightComponent.CASCADE_COLORS.length]!;
      physicsDebug.addFrustumSlices(this.shadowCameras[i]!.getInvViewProjectionMatrix(), col);
    }
  }

  public override renderInMenu(folder?: any): void {
    if (!folder) return;
    if (this._editorFolder) return;

    const entityName = this.getOwner()?.getName() ?? 'Directional Light';
    this._editorFolder = folder.addFolder(entityName);
    this._editorFolder.close();

    this._editorFolder.add(this, 'linkedToTimeOfDay').name('Link Time of Day').listen();
    this._editorFolder.addColor(this, 'guiColorHex').name('Color').listen();
    this._editorFolder.add(this, 'intensity', 0.0, 30.0).name('Intensity').listen();
    this._editorFolder
      .add(this.lightDirection, '0', -1.0, 1.0)
      .name('Dir X')
      .onChange(() => vec3.normalize(this.lightDirection, this.lightDirection))
      .listen();
    this._editorFolder
      .add(this.lightDirection, '1', -1.0, 1.0)
      .name('Dir Y')
      .onChange(() => vec3.normalize(this.lightDirection, this.lightDirection))
      .listen();
    this._editorFolder
      .add(this.lightDirection, '2', -1.0, 1.0)
      .name('Dir Z')
      .onChange(() => vec3.normalize(this.lightDirection, this.lightDirection))
      .listen();
    this._editorFolder.add(this, 'hasShadows').name('Enable Shadows').listen();
    this._editorFolder
      .add(this, 'maxShadowDistance', 10.0, 200.0)
      .name('Max Shadow Distance')
      .listen();
    if (this.cascadeCount > 1) {
      this._editorFolder.add(this, 'cascadeLambda', 0.0, 1.0).name('Cascade Lambda').listen();
    }
  }

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

  /**
   * Returns the world-space direction FROM any surface TOWARD this light source.
   * This is the negation of the internal lightDirection (which points FROM source TO target).
   * Use this for contact shadows or other effects that need the "toward light" direction.
   */
  public getLightDirectionToSource(): vec3 {
    const result = vec3.create();
    vec3.negate(result, this.lightDirection);
    return result;
  }

  // Setters for atmospheric lighting system
  public setColor(color: number[]): void {
    this.color = color;
  }

  public getColor(): number[] {
    return this.color;
  }

  public setIntensity(intensity: number): void {
    this.intensity = intensity;
  }

  public getIntensity(): number {
    return this.intensity;
  }

  public setLightDirection(direction: vec3): void {
    vec3.normalize(this.lightDirection, direction);
  }

  // GUI color hex string with getter/setter (for .listen() to work like intensity)
  public get guiColorHex(): string {
    const r = Math.round(this.color[0] * 255)
      .toString(16)
      .padStart(2, '0');
    const g = Math.round(this.color[1] * 255)
      .toString(16)
      .padStart(2, '0');
    const b = Math.round(this.color[2] * 255)
      .toString(16)
      .padStart(2, '0');
    return `#${r}${g}${b}`;
  }

  public set guiColorHex(hex: string) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result) {
      this.color[0] = parseInt(result[1], 16) / 255;
      this.color[1] = parseInt(result[2], 16) / 255;
      this.color[2] = parseInt(result[3], 16) / 255;
    }
  }
}
