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
  private projectorTexture!: Texture;
  private projectorTextureView!: GPUTextureView;

  // CSM configuration
  private cascadeCount: number = 1; // Number of cascades (1-3)
  private cascadeSplits: number[] = []; // Split distances (calculadas dinámicamente)
  private cascadeLambda: number = 0.5; // 0=uniform, 1=logarithmic
  private maxShadowDistance: number = 50.0; // Distancia máxima de sombras (no usar full frustum)

  private shadowFov: number = 0;
  private shadowAspect: number = 0;
  private splitsInitialized: boolean = false;

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
    this.projectorTexture = await Texture.getAsync(
      lightData.projector ? lightData.projector : 'white.png',
    );
    this.projectorTextureView = this.projectorTexture.getTextureView()!;

    // Cargar técnica apropiada (CSM o single shadow)
    const techniquePath =
      this.cascadeCount > 1
        ? 'lighting/directional_light_csm.tech'
        : 'lighting/directional_light.tech';
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
        {
          binding: 3,
          resource: this.projectorTextureView!,
        },
        {
          binding: 4,
          resource: SamplerLibrary.simpleSampler,
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

  private updateShadowCameras(mainCamera: Camera): void {
    if (!this.splitsInitialized) {
      const near = mainCamera.getNear();
      const far = Math.min(this.maxShadowDistance, mainCamera.getFar());
      this.cascadeSplits = this.calculateCascadeSplits(near, far);
      this.shadowFov = mainCamera.getFov();
      this.shadowAspect = mainCamera.getAspectRatio();
      this.splitsInitialized = true;
    }

    const shadowResolution =
      QualitySettings.getInstance().getSettings().directionalShadowMapResolution;

    const lightUp =
      Math.abs(this.lightDirection[2]) > 0.9 ? vec3.fromValues(0, 1, 0) : vec3.fromValues(0, 0, 1);

    let prevSplit = mainCamera.getNear();

    for (let i = 0; i < this.cascadeCount; i++) {
      const currentSplit = this.cascadeSplits[i];

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
      const worldCenter = vec3.create();
      for (const corner of frustumCorners) {
        vec3.add(worldCenter, worldCenter, corner);
      }
      vec3.scale(worldCenter, worldCenter, 1.0 / frustumCorners.length);

      // 3. Construir lightView desde worldCenter
      const lightPos = vec3.create();
      vec3.scaleAndAdd(
        lightPos,
        worldCenter,
        this.lightDirection,
        -DirectionalLightComponent.LIGHT_DISTANCE,
      );
      const lightView = mat4.create();
      mat4.lookAt(lightView, lightPos, worldCenter, lightUp);

      // 4. SNAP: modificar directamente los elementos de traslación de lightView
      // lightView[12] y [13] ya están en light space — no hay que transformar nada
      // Esto evita el ciclo invert→transformar→lookAt que destruye el snap
      lightView[12] = Math.floor(lightView[12] / texelSize) * texelSize;
      lightView[13] = Math.floor(lightView[13] / texelSize) * texelSize;
      // lightView[14] no se snapea — es profundidad Z

      // 5. Calcular near/far Z desde los corners + extensión para shadow casters
      const Z_EXTENSION = this.maxShadowDistance * 0.5;
      const allCorners = [
        ...frustumCorners,
        ...frustumCorners.map((c) => {
          const ext = vec3.create();
          vec3.scaleAndAdd(ext, c, this.lightDirection, -Z_EXTENSION);
          return ext;
        }),
      ];

      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const corner of allCorners) {
        const lsc = vec3.create();
        vec3.transformMat4(lsc, corner, lightView);
        minZ = Math.min(minZ, lsc[2]);
        maxZ = Math.max(maxZ, lsc[2]);
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
    const shadowStep = 1.0;
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

  public override renderDebug(): void {}

  public override renderInMenu(): void {
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;

    // Use raw lil-gui API for proper value tracking with .listen()
    const folder = (gui as any).folders?.get('Directional Light') || gui;

    // Color picker with .listen() for automatic updates (works like intensity)
    // The setter/getter automatically sync with this.color
    folder.addColor(this, 'guiColorHex').name('Color').listen();

    // Intensity slider with .listen() for automatic updates
    folder.add(this, 'intensity', 0.0, 30.0).name('Intensity').listen();

    gui.addSeparator();

    // Light Direction with .listen() for automatic updates when atmospheric system changes it
    folder
      .add(this.lightDirection, '0', -1.0, 1.0)
      .name('Dir X')
      .onChange(() => {
        vec3.normalize(this.lightDirection, this.lightDirection);
      })
      .listen();

    folder
      .add(this.lightDirection, '1', -1.0, 1.0)
      .name('Dir Y')
      .onChange(() => {
        vec3.normalize(this.lightDirection, this.lightDirection);
      })
      .listen();

    folder
      .add(this.lightDirection, '2', -1.0, 1.0)
      .name('Dir Z')
      .onChange(() => {
        vec3.normalize(this.lightDirection, this.lightDirection);
      })
      .listen();

    gui.addSeparator();

    // Shadows toggle
    folder.add(this, 'hasShadows').name('Enable Shadows').listen();

    // Shadow parameters (only shown if shadows enabled)
    if (this.hasShadows) {
      folder.add(this, 'maxShadowDistance', 10.0, 200.0).name('Max Shadow Distance').listen();

      // Cascade lambda (only if using multiple cascades)
      if (this.cascadeCount > 1) {
        folder.add(this, 'cascadeLambda', 0.0, 1.0).name('Cascade Lambda').listen();
      }
    }

    gui.addSeparator();

    // Read-only information
    const cascadeInfo = { value: this.cascadeCount };
    gui.addDynamicText(cascadeInfo, 'value', 'Cascade Count');
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

  // Setters for atmospheric lighting system
  public setColor(color: number[]): void {
    this.color = color;
  }

  public setIntensity(intensity: number): void {
    this.intensity = intensity;
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
