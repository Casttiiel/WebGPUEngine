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
}

export class DirectionalLightComponent extends Component {
  private fullscreenQuadMesh!: Mesh;
  private directionalLightTechnique!: Technique;
  private directionalLightBindGroup!: GPUBindGroup;
  private uniformBuffer!: GPUBuffer;

  // CSM: 3 cascadas
  private static readonly NUM_CASCADES = 3;
  private shadowDepthTextures: GPUTexture[] = [];
  private shadowDepthViews: GPUTextureView[] = [];
  private shadowSampler!: GPUSampler;
  private cameras: Camera[] = [];

  // Distancias de cascada (calculadas dinámicamente con PSSM)
  private cascadeSplits: number[] = []; // near de cada cascada
  private cascadeFarPlanes: number[] = []; // far de cada cascada

  // Configuración PSSM
  private pssmLambda: number = 0.75; // 0=uniforme, 1=logarítmico

  // Dirección de luz (para frustum fitting)
  private lightDirection: vec3 = vec3.create();

  private hasShadows!: boolean;
  private color!: number[];
  private intensity!: number;

  // Debug
  private _debugVisualizeCascades: boolean = false; // Prefixed with _ to mark as potentially unused

  constructor() {
    super();
  }

  public async load(lightData: DirectionalLightData): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');
    this.directionalLightTechnique = await Technique.getAsync('directional_light_csm.tech');

    // Uniform buffer layout para CSM:
    // - color (vec4) - 16 bytes
    // - direction + intensity (vec4) - 16 bytes
    // - 3x lightViewProjOffset matrices (mat4x4) - 3 * 64 = 192 bytes
    // - cascadeSplits (vec4) - 16 bytes (3 splits + padding)
    // - shadowParams (vec4) - 16 bytes (shadowStep, inverseRes, stepDivRes, padding)
    // Total: 16 + 16 + 192 + 16 + 16 = 256 bytes
    this.uniformBuffer = GPUUtils.createBuffer(
      'directional_light_csm_uniform_buffer',
      256,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Crear 3 texturas de profundidad para CSM
    const shadowMapRes = QualitySettings.getInstance().getSettings().directionalShadowMapResolution;
    for (let i = 0; i < DirectionalLightComponent.NUM_CASCADES; i++) {
      const shadowDepthTexture = GPUUtils.createTexture(
        `directional_light_csm_shadow_map_${i}`,
        shadowMapRes,
        shadowMapRes,
        'depth32float',
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      );

      const shadowDepthView = shadowDepthTexture.createView({
        aspect: 'depth-only',
      });

      this.shadowDepthTextures.push(shadowDepthTexture);
      this.shadowDepthViews.push(shadowDepthView);
    }

    // Crear sampler de comparación para shadow mapping
    this.shadowSampler = SamplerLibrary.shadows;

    // Crear bind group con 3 shadow maps
    this.directionalLightBindGroup = BindGroupFactory.createBindGroup(
      `directional_light_csm_bindgroup`,
      this.directionalLightTechnique.getPipeline().getBindGroupLayout(2)!,
      [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
        {
          binding: 1,
          resource: this.shadowDepthViews[0]!, // Cascade 0 (near)
        },
        {
          binding: 2,
          resource: this.shadowDepthViews[1]!, // Cascade 1 (mid)
        },
        {
          binding: 3,
          resource: this.shadowDepthViews[2]!, // Cascade 2 (far)
        },
        {
          binding: 4,
          resource: this.shadowSampler, // Shared comparison sampler
        },
      ],
    );

    // Inicializar splits estáticos para las cascadas (se actualizarán dinámicamente con updateCascades)
    // Valores por defecto para una cámara con near=0.1, far=500
    this.cascadeSplits = [0.1, 10.0, 50.0];
    this.cascadeFarPlanes = [10.0, 50.0, 500.0];

    // Crear 3 cámaras ortográficas para las cascadas
    const basePosition = vec3.fromValues(
      lightData.position[0] ?? 0,
      lightData.position[1] ?? 25,
      lightData.position[2] ?? 0,
    );
    const baseTarget = vec3.fromValues(
      lightData.target[0] ?? 0,
      lightData.target[1] ?? 0,
      lightData.target[2] ?? 0,
    );

    for (let i = 0; i < DirectionalLightComponent.NUM_CASCADES; i++) {
      const camera = new Camera();
      camera.setNearPlane(this.cascadeSplits[i]!);
      camera.setFarPlane(this.cascadeFarPlanes[i]!);

      // Tamaño ortográfico aumenta con la distancia de la cascada
      const orthoSize = (lightData.orthoWidth || 20) * (1 + i * 0.5);
      camera.setOrthoParams(true, 0, orthoSize, 0, orthoSize);
      camera.lookAt(basePosition, baseTarget, vec3.fromValues(0.0, 0.0, 1.0));
      camera.updateUniforms();

      this.cameras.push(camera);
    }

    this.hasShadows = lightData.hasShadows ?? false;
    this.color = lightData.color ?? [1.0, 1.0, 1.0];
    this.intensity = lightData.intensity ?? 1.0;

    // Calcular dirección de luz inicial
    const target = vec3.fromValues(
      lightData.target[0] ?? 0,
      lightData.target[1] ?? 0,
      lightData.target[2] ?? 0,
    );
    const position = vec3.fromValues(
      lightData.position[0] ?? 0,
      lightData.position[1] ?? 25,
      lightData.position[2] ?? 0,
    );
    const dir = vec3.subtract(vec3.create(), target, position);
    vec3.normalize(this.lightDirection, dir);

    this.updateLightUniforms();
  }

  /**
   * Calcula splits de cascada usando PSSM (Practical Split Scheme)
   * Combina distribución uniforme y logarítmica para mejor balance
   */
  private calculatePSSMSplits(mainCamera: Camera): void {
    const near = mainCamera.getNear();
    const far = mainCamera.getFar();

    this.cascadeSplits = [];
    this.cascadeFarPlanes = [];

    for (let i = 0; i < DirectionalLightComponent.NUM_CASCADES; i++) {
      const p = (i + 1) / DirectionalLightComponent.NUM_CASCADES;

      // Split logarítmico (más detalle cerca)
      const cLog = near * Math.pow(far / near, p);

      // Split uniforme (distribución equitativa)
      const cUniform = near + (far - near) * p;

      // Interpolación PSSM
      const split = this.pssmLambda * cLog + (1 - this.pssmLambda) * cUniform;

      this.cascadeSplits.push(i === 0 ? near : this.cascadeFarPlanes[i - 1] || 0);
      this.cascadeFarPlanes.push(split);
    }
  }

  /**
   * Extrae las 8 esquinas del frustum de la cámara en world space
   */
  private getFrustumCornersWorldSpace(camera: Camera, nearPlane: number, farPlane: number): vec3[] {
    const invViewProj = mat4.create();
    mat4.multiply(invViewProj, camera.getProjection(), camera.getView());
    mat4.invert(invViewProj, invViewProj);

    const corners: vec3[] = [];

    // 8 esquinas del frustum en NDC space
    for (let x = 0; x < 2; x++) {
      for (let y = 0; y < 2; y++) {
        for (let z = 0; z < 2; z++) {
          const pt = vec3.fromValues(
            x * 2.0 - 1.0, // -1 o 1
            y * 2.0 - 1.0, // -1 o 1
            z, // 0 (near) o 1 (far)
          );

          // Transformar de NDC a world space
          const corner = vec3.create();
          vec3.transformMat4(corner, pt, invViewProj);

          // Interpolar entre near y far plane basado en z
          const viewPos = vec3.create();
          vec3.transformMat4(viewPos, pt, mat4.invert(mat4.create(), camera.getView()));
          const t = z === 0 ? nearPlane / Math.abs(viewPos[2]) : farPlane / Math.abs(viewPos[2]);
          vec3.scaleAndAdd(corner, camera.getPosition(), viewPos, t);

          corners.push(corner);
        }
      }
    }

    return corners;
  }

  /**
   * Ajusta una cámara de cascada para que cubra exactamente un slice del frustum
   */
  private fitCascadeToFrustum(
    cascadeIndex: number,
    mainCamera: Camera,
    nearPlane: number,
    farPlane: number,
  ): void {
    // Obtener esquinas del frustum para este rango de profundidad
    const frustumCorners = this.getFrustumCornersWorldSpace(mainCamera, nearPlane, farPlane);

    // Calcular el centro del frustum
    const frustumCenter = vec3.create();
    for (const corner of frustumCorners) {
      vec3.add(frustumCenter, frustumCenter, corner);
    }
    vec3.scale(frustumCenter, frustumCenter, 1.0 / frustumCorners.length);

    // Crear matriz de vista de la luz (mirando en dirección de luz)
    const lightView = mat4.create();
    const up = vec3.fromValues(0, 1, 0);

    // Si la luz es casi vertical, usar otro vector up
    if (Math.abs(this.lightDirection[1]) > 0.99) {
      vec3.set(up, 0, 0, 1);
    }

    // Posicionar la luz "arriba" del frustum center mirando hacia abajo
    const lightPos = vec3.create();
    vec3.scaleAndAdd(lightPos, frustumCenter, this.lightDirection, 50.0);

    mat4.lookAt(lightView, lightPos, frustumCenter, up);

    // Transformar esquinas del frustum a light space
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;
    let minZ = Infinity,
      maxZ = -Infinity;

    for (const corner of frustumCorners) {
      const lightSpaceCorner = vec3.create();
      vec3.transformMat4(lightSpaceCorner, corner, lightView);

      minX = Math.min(minX, lightSpaceCorner[0]);
      maxX = Math.max(maxX, lightSpaceCorner[0]);
      minY = Math.min(minY, lightSpaceCorner[1]);
      maxY = Math.max(maxY, lightSpaceCorner[1]);
      minZ = Math.min(minZ, lightSpaceCorner[2]);
      maxZ = Math.max(maxZ, lightSpaceCorner[2]);
    }

    // Expandir bounds en Z para incluir posibles casters fuera del frustum
    const zRange = maxZ - minZ;
    minZ -= zRange * 0.5; // Extender hacia atrás
    maxZ += zRange * 0.1; // Un poco hacia adelante

    // Configurar cámara ortográfica para cubrir exactamente este AABB
    const camera = this.cameras[cascadeIndex];
    if (!camera) return;

    camera.setNearPlane(0.0);
    camera.setFarPlane(maxZ - minZ);
    camera.setOrthoParams(false, minX, maxX, minY, maxY);

    // Calcular posición de la cámara en light space
    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    const lightSpacePos = vec3.fromValues(centerX, centerY, maxZ); // Posición en el far plane

    // Transformar de light space a world space
    const invLightView = mat4.invert(mat4.create(), lightView);
    const worldPos = vec3.transformMat4(vec3.create(), lightSpacePos, invLightView);

    // Target está en el centro del AABB
    const lightSpaceTarget = vec3.fromValues(centerX, centerY, (minZ + maxZ) * 0.5);
    const worldTarget = vec3.transformMat4(vec3.create(), lightSpaceTarget, invLightView);

    camera.lookAt(worldPos, worldTarget, up);
    camera.updateUniforms();
  }

  /**
   * Actualiza todas las cascadas para seguir la cámara principal
   * Debe llamarse cada frame ANTES de generateShadowMap()
   */
  public updateCascades(mainCamera: Camera): void {
    // Recalcular splits basados en near/far de cámara actual
    this.calculatePSSMSplits(mainCamera);

    // Ajustar cada cascada al frustum
    for (let i = 0; i < DirectionalLightComponent.NUM_CASCADES; i++) {
      this.fitCascadeToFrustum(i, mainCamera, this.cascadeSplits[i]!, this.cascadeFarPlanes[i]!);
    }
  }

  private updateLightUniforms(): void {
    // Uniform buffer layout para CSM (256 bytes total):
    // Offset 0-15: color (vec4) - RGB + hasShadows flag
    // Offset 16-31: direction (vec3) + intensity (f32)
    // Offset 32-95: lightViewProjOffset[0] (mat4x4) - Cascade 0
    // Offset 96-159: lightViewProjOffset[1] (mat4x4) - Cascade 1
    // Offset 160-223: lightViewProjOffset[2] (mat4x4) - Cascade 2
    // Offset 224-239: cascadeSplits (vec4) - 3 far planes + padding
    // Offset 240-255: shadowParams (vec4) - shadowStep, inverseRes, stepDivRes, padding

    // color (vec4) - bytes 0-15
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      0,
      new Float32Array([
        this.color[0]!,
        this.color[1]!,
        this.color[2]!,
        this.hasShadows ? 1.0 : 0.0,
      ]),
    );

    // Para luz direccional: la dirección debe ser HACIA la fuente de luz
    const cameraDirection = this.cameras[0]!.getFront();
    const lightDirection = vec3.fromValues(
      -cameraDirection[0],
      -cameraDirection[1],
      -cameraDirection[2],
    );

    // direction (vec3) + intensity (f32) - bytes 16-31
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      16,
      new Float32Array([lightDirection[0], lightDirection[1], lightDirection[2], this.intensity]),
    );

    // Crear matriz de transformación de clip space a UV space (reutilizable)
    const mtx_scale = mat4.create();
    const mtx_translation = mat4.create();
    const mtx_offset = mat4.create();

    mat4.scale(mtx_scale, mat4.create(), [0.5, -0.5, 1.0]);
    mat4.translate(mtx_translation, mat4.create(), [0.5, 0.5, 0.0]);
    mat4.multiply(mtx_offset, mtx_translation, mtx_scale);

    // Escribir 3 matrices lightViewProjOffset (una por cascada)
    for (let i = 0; i < DirectionalLightComponent.NUM_CASCADES; i++) {
      const lightViewProjOffset = mat4.create();
      mat4.multiply(lightViewProjOffset, mtx_offset, this.cameras[i]!.getViewProjection());

      const offset = 32 + i * 64; // 32, 96, 160
      GPUUtils.writeBuffer(this.uniformBuffer, offset, new Float32Array(lightViewProjOffset));
    }

    // cascadeSplits (vec4) - bytes 224-239
    // Usar los far planes de cada cascada para selección en el shader
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      224,
      new Float32Array([
        this.cascadeFarPlanes[0]!,
        this.cascadeFarPlanes[1]!,
        this.cascadeFarPlanes[2]!,
        0.0, // padding
      ]),
    );

    // shadowParams (vec4) - bytes 240-255
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
    const shadowMapRes = QualitySettings.getInstance().getSettings().directionalShadowMapResolution;

    // Renderizar 3 cascadas independientemente
    for (let i = 0; i < DirectionalLightComponent.NUM_CASCADES; i++) {
      // Culling específico para esta cascada
      RenderManager.getInstance().performCulling(this.cameras[i]!, RenderCategory.SHADOWS);

      // Renderizar a la textura de profundidad de esta cascada
      const depthStencilAttachment = GPUUtils.createDepthStencilAttachment(
        this.shadowDepthViews[i]!,
      );

      const pass = render.getCommandEncoder().beginRenderPass(
        GPUUtils.createRenderPassDescriptor(
          `directional_light_csm_shadow_map_cascade_${i}`,
          [], // Sin color attachments
          depthStencilAttachment,
        ),
      );

      GPUUtils.configureViewportAndScissor(pass, shadowMapRes, shadowMapRes);

      // Configurar cámara de esta cascada
      RenderManager.getInstance().setCamera(this.cameras[i]!);

      // Renderizar objetos con sombra
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

  public override update(_dt: number): void {
    this.updateLightUniforms();
  }

  public override renderInMenu(): void {
    const debugUI = Engine.getDebugUI();
    const folder = 'Directional Light CSM';

    // Light properties
    debugUI.addInteractiveControl(folder, this, 'intensity', 'Intensity', {
      min: 0.0,
      max: 10.0,
      step: 0.1,
    });

    debugUI.addInteractiveControl(folder, this, 'hasShadows', 'Enable Shadows');
    debugUI.addInteractiveControl(folder, this, 'debugVisualizeCascades', 'Visualize Cascades');

    // Cascade splits (far planes)
    debugUI.addInteractiveControl(folder, this.cascadeFarPlanes, '0', 'Cascade 0 Far', {
      min: 1.0,
      max: 100.0,
      step: 1.0,
    });
    debugUI.addInteractiveControl(folder, this.cascadeFarPlanes, '1', 'Cascade 1 Far', {
      min: 10.0,
      max: 300.0,
      step: 5.0,
    });
    debugUI.addInteractiveControl(folder, this.cascadeFarPlanes, '2', 'Cascade 2 Far', {
      min: 100.0,
      max: 1000.0,
      step: 10.0,
    });

    // Color
    debugUI.addDebugControl(folder, this.color, '0', 'Color R');
    debugUI.addDebugControl(folder, this.color, '1', 'Color G');
    debugUI.addDebugControl(folder, this.color, '2', 'Color B');
  }

  public override renderDebug(): void {}
}
