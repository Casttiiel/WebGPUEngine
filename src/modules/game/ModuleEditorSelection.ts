import { Module } from '../core/Module';
import { Engine } from '../../core/engine/Engine';
import { Entity } from '../../core/ecs/Entity';
import { CameraComponent } from '../../components/render/CameraComponent';
import { vec3, mat4, vec4 } from 'gl-matrix';
import { MouseButton } from '../../types/MouseButton.enum';
import { RenderComponent } from '../../components/render/RenderComponent';
import { TransformComponent } from '../../components/core/TransformComponent';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { Render } from '../../renderer/core/pipeline/Render';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { GizmoRenderer } from '../../renderer/editor/GizmoRenderer';
import { GizmoMode } from '../../types/GizmoMode.enum';
import { GizmoAxis } from '../../types/GizmoAxis.enum';
import { KeyCode } from '../../types/KeyCode.enum';
import { ReflectionProbeComponent } from '../../components/render/ReflectionProbeComponent';
import { BoxColliderComponent } from '../../components/physics/BoxColliderComponent';
import { Material } from '../../renderer/resources/Material';

export class ModuleEditorSelection extends Module {
  private selectedEntity: Entity | null = null;
  private hoveredEntity: Entity | null = null;

  // ── Material Inspector ──────────────────────────────────────────────────────
  /** Tracks which entity was last synced to avoid re-syncing every frame. */
  private _lastInspectedEntity: Entity | null = null;
  /** Proxy object bound to lil-gui sliders via .listen(). Synced on selection change. */
  private _matProxy = {
    meshName: '— none —',
    materialName: '— none —',
    technique: '— none —',
    pomScale: 0,
    roughnessFactor: 1,
    metallicFactor: 1,
    emissiveFactor: 1,
    uvXScale: 1,
    uvYScale: 1,
    appearanceBlend: 1,
    surfaceBlend: 1,
  };
  private hoverCheckInterval: number = 0.05; // Check hover cada 50ms para performance
  private hoverCheckTimer: number = 0;
  private lastMousePosition: { x: number; y: number } = { x: 0, y: 0 };

  // Wireframe rendering resources
  private wireframePipeline!: GPURenderPipeline;
  private wireframeUniformBuffer!: GPUBuffer;
  private wireframeBindGroupLayout!: GPUBindGroupLayout;
  private cameraBindGroupLayout!: GPUBindGroupLayout;
  private objectBindGroupLayout!: GPUBindGroupLayout;
  private barycentricBuffer!: GPUBuffer; // Buffer de coordenadas baricéntricas
  private currentWireframeMesh: {
    positionBuffer: GPUBuffer;
    barycentricBuffer: GPUBuffer;
    vertexCount: number;
  } | null = null;

  // Gizmo system
  private gizmoRenderer!: GizmoRenderer;
  private gizmoMode: GizmoMode = GizmoMode.TRANSLATE;
  private gizmoScale: number = 1.0;

  // Store initial scale for drag (for scale gizmo)
  private _dragStartScale: vec3 | null = null;

  // ---- Probe resize state ----
  // Which face handle is being dragged (PROBE_PX … PROBE_NZ)
  private probeDragFace: GizmoAxis = GizmoAxis.NONE;
  // Current hovered face handle (for highlight)
  private probeHoveredHandle: GizmoAxis = GizmoAxis.NONE;
  // Half-extents at drag-start (so we can compute delta from origin)
  private _probeDragStartHalfExtents: vec3 | null = null;
  // Face center world position at drag-start
  private _probeDragStartFaceCenter: vec3 | null = null;

  // Gizmo dragging state
  private isDragging: boolean = false;
  private draggedAxis: GizmoAxis = GizmoAxis.NONE;
  private dragStartWorldPos: vec3 = vec3.create();
  private dragStartMousePos: { x: number; y: number } = { x: 0, y: 0 };
  private dragPlaneNormal: vec3 = vec3.create();
  private dragPlanePoint: vec3 = vec3.create();

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    console.log('ModuleEditorSelection started');

    const device = GPUUtils.getDevice();

    // Cargar shaders wireframe
    const vsCode = await ResourceManager.loadShader('utility/wireframe.vs');
    const fsCode = await ResourceManager.loadShader('utility/wireframe.fs');

    const vsModule = device.createShaderModule({ label: 'wireframe_vs', code: vsCode });
    const fsModule = device.createShaderModule({ label: 'wireframe_fs', code: fsCode });

    // Crear bind group layouts
    this.cameraBindGroupLayout = device.createBindGroupLayout({
      label: 'wireframe_camera_layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this.objectBindGroupLayout = device.createBindGroupLayout({
      label: 'wireframe_object_layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this.wireframeBindGroupLayout = device.createBindGroupLayout({
      label: 'wireframe_uniforms_layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    // Crear pipeline layout
    const pipelineLayout = device.createPipelineLayout({
      label: 'wireframe_pipeline_layout',
      bindGroupLayouts: [
        this.cameraBindGroupLayout,
        this.objectBindGroupLayout,
        this.wireframeBindGroupLayout,
      ],
    });

    // Crear render pipeline con vertex layout custom (position + barycentric)
    this.wireframePipeline = device.createRenderPipeline({
      label: 'wireframe_pipeline',
      layout: pipelineLayout,
      vertex: {
        module: vsModule,
        entryPoint: 'main',
        buffers: [
          // Buffer 0: Position (from interleaved mesh buffer, stride 48 bytes)
          {
            arrayStride: 48, // Mesh.VERTEX_STRIDE_BYTES — interleaved buffer
            attributes: [
              {
                shaderLocation: 0,
                offset: 0,
                format: 'float32x3', // position at byte offset 0
              },
            ],
          },
        ],
      },
      fragment: {
        module: fsModule,
        entryPoint: 'main',
        targets: [
          {
            format: 'bgra8unorm', // Formato del canvas (renderizamos directo sobre el swapchain)
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: {
        topology: 'line-list', // Usar líneas en lugar de triángulos
        cullMode: 'none',
      },
      // Sin depthStencil para debugging - wireframe siempre visible
    });

    // Crear buffer de uniforms para wireframe (color + lineWidth + padding)
    // Estructura en WGSL con alineación:
    // - color: vec4<f32> @ offset 0 (16 bytes)
    // - lineWidth: f32 @ offset 16 (4 bytes)
    // - padding implícito (12 bytes)
    // - _padding: vec3<f32> @ offset 32 (12 bytes, alineado a 16)
    // - padding final (4 bytes para múltiplo de 16)
    // Total: 48 bytes
    this.wireframeUniformBuffer = device.createBuffer({
      label: 'wireframe_uniforms',
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Generar coordenadas baricéntricas para el cubo
    // El cubo tiene 36 vértices (6 caras x 2 triángulos x 3 vértices)
    const vertexCount = 36;
    const barycentrics: number[] = [];

    // Cada triángulo tiene coordenadas baricéntricas (1,0,0), (0,1,0), (0,0,1)
    for (let i = 0; i < vertexCount / 3; i++) {
      barycentrics.push(1, 0, 0); // Vértice 1
      barycentrics.push(0, 1, 0); // Vértice 2
      barycentrics.push(0, 0, 1); // Vértice 3
    }

    this.barycentricBuffer = device.createBuffer({
      label: 'cube_barycentrics',
      size: barycentrics.length * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.barycentricBuffer, 0, new Float32Array(barycentrics));

    // Inicializar sistema de gizmos
    this.gizmoRenderer = new GizmoRenderer();
    await this.gizmoRenderer.initialize();
    console.log('✅ Gizmo system initialized');

    return true;
  }

  public stop(): void {
    this.selectedEntity = null;
    this.hoveredEntity = null;

    // Limpiar recursos wireframe
    if (this.wireframeUniformBuffer) {
      this.wireframeUniformBuffer.destroy();
    }
    if (this.currentWireframeMesh) {
      this.currentWireframeMesh.positionBuffer.destroy();
      this.currentWireframeMesh.barycentricBuffer.destroy();
      this.currentWireframeMesh = null;
    }

    // Limpiar gizmo
    if (this.gizmoRenderer) {
      this.gizmoRenderer.destroy();
    }

    console.log('ModuleEditorSelection stopped');
  }

  public update(dt: number): void {
    const input = Engine.getInput();

    // Si estamos arrastrando, procesar el arrastre
    if (this.isDragging) {
      this.processDragging();
      // Soltar al liberar el botón
      if (input.isMouseButtonJustReleased(MouseButton.LEFT)) {
        this.stopDragging();
      }
      return; // No procesar selección/hover mientras se arrastra
    }

    // Cambiar modo de gizmo con Space si hay selección y no estamos arrastrando
    if (this.selectedEntity && !this.isDragging && input.isKeyJustPressed(KeyCode.SPACE)) {
      this.cycleGizmoMode();
    }

    // Click izquierdo para seleccionar o iniciar arrastre
    if (input.isMouseButtonJustPressed(MouseButton.LEFT)) {
      this.performSelection();
    }

    // Hover detection con throttle para performance
    this.hoverCheckTimer += dt;

    const mousePos = input.getMousePosition();
    const mouseMoved =
      Math.abs(mousePos.x - this.lastMousePosition.x) > 1 ||
      Math.abs(mousePos.y - this.lastMousePosition.y) > 1;

    // Solo hacer raycast si pasó suficiente tiempo O el mouse se movió significativamente
    if (this.hoverCheckTimer >= this.hoverCheckInterval || mouseMoved) {
      this.hoverCheckTimer = 0;
      this.lastMousePosition = { ...mousePos };
      this.performHoverDetection();
    }

    // Refresh the material inspector proxy whenever the selection changes.
    this.refreshMaterialInspector();
  }

  /**
   * Cambia el modo de gizmo (TRANSLATE, SCALE, ROTATE, ...)
   */
  private cycleGizmoMode(): void {
    if (this.selectedEntity && this.isProbeEntity(this.selectedEntity)) {
      // For probes: toggle between TRANSLATE and PROBE_RESIZE
      this.gizmoMode =
        this.gizmoMode === GizmoMode.TRANSLATE ? GizmoMode.PROBE_RESIZE : GizmoMode.TRANSLATE;
      return;
    }
    // El orden será: TRANSLATE → SCALE → ROTATE → TRANSLATE ...
    const modes = [GizmoMode.TRANSLATE, GizmoMode.SCALE, GizmoMode.ROTATE];
    const currentIdx = modes.indexOf(this.gizmoMode);
    const nextIdx = (currentIdx + 1) % modes.length;
    this.gizmoMode = modes[nextIdx] ?? GizmoMode.TRANSLATE;
  }

  private performSelection(): void {
    const camera = this.getEditorCamera();
    if (!camera) {
      console.warn('No editor camera found');
      return;
    }

    const input = Engine.getInput();
    const mousePos = input.getMousePosition();

    // Convertir mouse position a ray en world space
    const ray = this.screenToWorldRay(mousePos, camera);

    // 1. Si hay probe seleccionado en modo PROBE_RESIZE, verificar clic en face handle
    if (this.selectedEntity && this.gizmoMode === GizmoMode.PROBE_RESIZE) {
      const probeComp = this.selectedEntity.getComponent(
        'reflection_probe',
      ) as ReflectionProbeComponent;
      const transformComp = this.selectedEntity.getComponent('transform') as TransformComponent;
      const boxComp = this.selectedEntity.getComponent('box_collider') as BoxColliderComponent;
      if (probeComp && transformComp && boxComp) {
        const center = transformComp.getTransform().getWorldPosition();
        const half = boxComp.getHalfExtents();
        const clickedHandle = this.gizmoRenderer.detectProbeHandleHover(
          center,
          half,
          ray.origin,
          ray.direction,
        );
        if (clickedHandle !== GizmoAxis.NONE) {
          this.startProbeFaceDrag(clickedHandle, center, half, mousePos, camera);
          return;
        }
      }
    }

    // 2. Si hay objeto seleccionado en modo TRANSLATE/SCALE, verificar clic en gizmo
    if (this.selectedEntity && this.gizmoMode !== GizmoMode.PROBE_RESIZE) {
      const transformComp = this.selectedEntity.getComponent('transform') as TransformComponent;
      if (transformComp) {
        const gizmoPosition = transformComp.getTransform().getWorldPosition();
        const cameraObj = camera.getCamera();
        const cameraPos = cameraObj.getPosition();
        const adaptiveScale = this.gizmoRenderer.calculateAdaptiveScale(
          gizmoPosition,
          cameraPos,
          this.gizmoScale,
        );
        const clickedAxis = this.gizmoRenderer.detectHover(
          gizmoPosition,
          ray.origin,
          ray.direction,
          adaptiveScale,
          this.gizmoMode === GizmoMode.SCALE,
        );

        if (clickedAxis !== GizmoAxis.NONE) {
          this.startDragging(clickedAxis, gizmoPosition, mousePos, camera);
          return;
        }
      }
    }

    // 3. Selección normal: primero non-sensor raycast, luego probe pick test
    const physics = Engine.getPhysics();
    const rayResult = physics.raycastClosestNonSensor(ray.origin, ray.direction, 10000.0);

    // Probes solo tienen sensor — el test es puramente matemático, sin guardia de oclusión
    const probeHit = this.findProbeEntityAtRay(ray.origin, ray.direction, camera.getCamera());

    if (probeHit) {
      if (probeHit !== this.selectedEntity) {
        this.selectedEntity = probeHit;
        this.gizmoMode = GizmoMode.TRANSLATE;
      }
    } else if (rayResult) {
      const entity = Engine.getEntities().getEntityById(rayResult.entityId);
      if (entity && entity !== this.selectedEntity) {
        this.selectedEntity = entity;
        if (this.isProbeEntity(entity)) {
          this.gizmoMode = GizmoMode.TRANSLATE;
        }
      }
    } else {
      if (this.selectedEntity) {
        this.selectedEntity = null;
        this.gizmoMode = GizmoMode.TRANSLATE;
      }
    }
  }

  private performHoverDetection(): void {
    const camera = this.getEditorCamera();
    if (!camera) {
      return;
    }

    const input = Engine.getInput();
    const mousePos = input.getMousePosition();

    const ray = this.screenToWorldRay(mousePos, camera);

    // 1. If a probe is selected in PROBE_RESIZE mode, check handle hover
    if (this.selectedEntity && this.gizmoMode === GizmoMode.PROBE_RESIZE) {
      const transformComp = this.selectedEntity.getComponent('transform') as TransformComponent;
      const boxComp = this.selectedEntity.getComponent('box_collider') as BoxColliderComponent;
      if (transformComp && boxComp) {
        const center = transformComp.getTransform().getWorldPosition();
        const half = boxComp.getHalfExtents();
        this.probeHoveredHandle = this.gizmoRenderer.detectProbeHandleHover(
          center,
          half,
          ray.origin,
          ray.direction,
        );
        this.hoveredEntity = null;
        return;
      }
    }
    this.probeHoveredHandle = GizmoAxis.NONE;

    // 2. Verificar hover sobre el gizmo (si hay objeto seleccionado, modo no-probe)
    if (this.selectedEntity && this.gizmoMode !== GizmoMode.PROBE_RESIZE) {
      const transformComp = this.selectedEntity.getComponent('transform') as TransformComponent;
      if (transformComp) {
        const gizmoPosition = transformComp.getTransform().getWorldPosition();
        const cameraObj = camera.getCamera();
        const cameraPos = cameraObj.getPosition();
        const adaptiveScale = this.gizmoRenderer.calculateAdaptiveScale(
          gizmoPosition,
          cameraPos,
          this.gizmoScale,
        );
        const hoveredAxis = this.gizmoRenderer.detectHover(
          gizmoPosition,
          ray.origin,
          ray.direction,
          adaptiveScale,
          this.gizmoMode === GizmoMode.SCALE,
        );

        this.gizmoRenderer.setHoveredAxis(hoveredAxis);

        if (hoveredAxis !== GizmoAxis.NONE) {
          this.hoveredEntity = null;
          return;
        }
      }
    }

    // 3. Hover sobre entidades (non-sensor)
    const physics = Engine.getPhysics();
    const result = physics.raycastClosestNonSensor(ray.origin, ray.direction, 10000.0);
    const probeHover = this.findProbeEntityAtRay(ray.origin, ray.direction, camera.getCamera());
    const newHoveredEntity =
      probeHover ?? (result ? Engine.getEntities().getEntityById(result.entityId) : null);

    if (newHoveredEntity !== this.hoveredEntity) {
      this.hoveredEntity = newHoveredEntity;
    }
  }

  /**
   * Inicia el arrastre de un objeto usando un eje del gizmo
   */
  private startDragging(
    axis: GizmoAxis,
    gizmoPosition: vec3,
    mousePos: { x: number; y: number },
    camera: CameraComponent,
  ): void {
    this.isDragging = true;
    this.draggedAxis = axis;
    vec3.copy(this.dragStartWorldPos, gizmoPosition);
    this.dragStartMousePos = { ...mousePos };

    // Calcular plano de arrastre perpendicular al eje seleccionado
    // El plano contiene el punto del gizmo y es perpendicular al eje
    const axisDir = vec3.create();
    switch (axis) {
      case GizmoAxis.X:
        vec3.set(axisDir, 1, 0, 0);
        break;
      case GizmoAxis.Y:
        vec3.set(axisDir, 0, 1, 0);
        break;
      case GizmoAxis.Z:
        vec3.set(axisDir, 0, 0, 1);
        break;
    }

    // El plano de arrastre usa la dirección de la cámara proyectada en el eje
    const cameraDir = camera.getCamera().getFront();
    vec3.cross(this.dragPlaneNormal, axisDir, cameraDir);
    vec3.cross(this.dragPlaneNormal, this.dragPlaneNormal, axisDir);
    vec3.normalize(this.dragPlaneNormal, this.dragPlaneNormal);
    vec3.copy(this.dragPlanePoint, gizmoPosition);
  }

  private getEditorCamera(): CameraComponent | null {
    const debugCamera = Engine.getEntities().getEntityByName('DebugCamera');
    if (!debugCamera) return null;

    return debugCamera.getComponent('camera') as CameraComponent;
  }

  private screenToWorldRay(
    mousePos: { x: number; y: number },
    cameraComponent: CameraComponent,
  ): { origin: vec3; direction: vec3 } {
    const camera = cameraComponent.getCamera();
    const canvas = document.getElementById('gfx-canvas') as HTMLCanvasElement;

    // 1️⃣ Mouse (CSS px) → NDC
    const rect = canvas.getBoundingClientRect();

    const x = ((mousePos.x - rect.left) / rect.width) * 2 - 1;
    const y = 1 - ((mousePos.y - rect.top) / rect.height) * 2;

    // 2️⃣ Clip space (far plane, WebGPU Z = 1)
    const rayClip = vec4.fromValues(x, y, 1, 1);

    // 3️⃣ Clip → View
    const invProj = mat4.create();
    mat4.invert(invProj, camera.getProjection());

    const rayView = vec4.create();
    vec4.transformMat4(rayView, rayClip, invProj);

    // Perspective divide
    rayView[0] /= rayView[3];
    rayView[1] /= rayView[3];
    rayView[2] /= rayView[3];
    rayView[3] = 0; // dirección

    // 4️⃣ View → World
    const invView = mat4.create();
    mat4.invert(invView, camera.getView());

    const rayWorld4 = vec4.create();
    vec4.transformMat4(rayWorld4, rayView, invView);

    const worldDirection = vec3.fromValues(rayWorld4[0], rayWorld4[1], rayWorld4[2]);
    vec3.normalize(worldDirection, worldDirection);

    // 5️⃣ Origin = posición de cámara
    const worldOrigin = vec3.create();
    mat4.getTranslation(worldOrigin, invView);

    return { origin: worldOrigin, direction: worldDirection };
  }

  public renderDebug(): void {
    // Renderizar wireframe del hovered entity (verde) — no para probes
    if (
      this.hoveredEntity &&
      this.selectedEntity !== this.hoveredEntity &&
      !this.isProbeEntity(this.hoveredEntity)
    ) {
      this.renderWireframeInFrame(this.hoveredEntity, [0.0, 10.0, 0.0, 1.0]);
    }

    // Renderizar wireframe del selected entity (rojo) — no para probes
    if (this.selectedEntity) {
      if (!this.isProbeEntity(this.selectedEntity)) {
        this.renderWireframeInFrame(this.selectedEntity, [10.0, 0.0, 0.0, 1.0]);
      }

      // Si es probe, dibujar el volumen del collider
      if (this.isProbeEntity(this.selectedEntity)) {
        this.renderProbeVolume();
      }

      // Renderizar gizmo en la posición del objeto seleccionado
      this.renderGizmo();
    }
  }

  /**
   * Renderiza el gizmo de transformación sobre el objeto seleccionado
   */
  private renderGizmo(): void {
    if (!this.selectedEntity) return;

    const transformComp = this.selectedEntity.getComponent('transform') as TransformComponent;
    if (!transformComp) return;

    const position = transformComp.getTransform().getWorldPosition();
    const camera = this.getEditorCamera();
    if (!camera) return;

    // Set the current transform for object space axes
    this.gizmoRenderer.currentTransform = transformComp.getTransform();

    // En modo PROBE_RESIZE no mostramos el gizmo XYZ (los handles de cara lo reemplazan)
    if (this.gizmoMode === GizmoMode.PROBE_RESIZE) return;

    // Renderizar según el modo activo
    switch (this.gizmoMode) {
      case GizmoMode.TRANSLATE:
        this.gizmoRenderer.renderTranslateGizmo(position, camera.getCamera(), this.gizmoScale);
        break;
      case GizmoMode.SCALE:
        this.gizmoRenderer.renderScaleGizmo(position, camera.getCamera(), this.gizmoScale);
        break;
      // TODO: Implementar ROTATE
    }
  }

  /**
   * Renderiza el wireframe de una entidad
   * @param entity - Entidad a renderizar
   * @param color - Color del wireframe [r, g, b, a]
   */
  public renderWireframeInFrame(entity: Entity, color: number[]): void {
    if (!entity) {
      return;
    }

    const device = GPUUtils.getDevice();

    // Obtener componentes del objeto
    const renderComp = entity.getComponent('render') as RenderComponent;
    if (!renderComp) {
      return;
    }

    const transformComp = entity.getComponent('transform') as TransformComponent;
    if (!transformComp) {
      return;
    }

    // Obtener el primer mesh del objeto (podemos iterar todos después)
    const parts = renderComp.getParts();
    if (parts.length === 0) {
      return;
    }

    const mesh = parts[0]!.mesh;

    // Generar index buffer de aristas desde el mesh
    // Cada triángulo tiene 3 aristas: (v0,v1), (v1,v2), (v2,v0)
    const indices = mesh.getIndices();
    const edgeIndices: number[] = [];

    for (let i = 0; i < indices.length; i += 3) {
      const v0 = indices[i]!;
      const v1 = indices[i + 1]!;
      const v2 = indices[i + 2]!;

      // Tres aristas del triángulo
      edgeIndices.push(v0, v1);
      edgeIndices.push(v1, v2);
      edgeIndices.push(v2, v0);
    }

    const edgeIndexBuffer = device.createBuffer({
      label: 'wireframe_edges',
      size: edgeIndices.length * Uint16Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(edgeIndexBuffer, 0, new Uint16Array(edgeIndices));

    // Actualizar color según el parámetro recibido
    const uniforms = new Float32Array([
      color[0]!,
      color[1]!,
      color[2]!,
      color[3]!, // Color personalizado
      0.1, // lineWidth más grueso (0.1 = más visible)
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    device.queue.writeBuffer(this.wireframeUniformBuffer, 0, uniforms);

    // Crear command encoder
    const encoder = device.createCommandEncoder({ label: 'test_fullscreen_triangle' });

    const renderPass = encoder.beginRenderPass({
      label: 'test_triangle_pass',
      colorAttachments: [
        {
          view: Render.getInstance().getContext().getCurrentTexture().createView(),
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });

    renderPass.setPipeline(this.wireframePipeline);

    // Bind group 0: Camera uniforms (de la cámara real)
    const renderModule = Engine.getRender();
    const camera = renderModule.getMainCamera();
    renderPass.setBindGroup(0, camera.getBindGroup());

    // Bind group 1: Object uniforms (matriz de transformación del objeto hovereado)
    const modelMatrix = transformComp.getTransform().getWorldMatrix();
    const objectUniformBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(objectUniformBuffer, 0, new Float32Array(modelMatrix));

    const objectBindGroup = device.createBindGroup({
      label: 'wireframe_object_bindgroup',
      layout: this.objectBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: objectUniformBuffer } }],
    });
    renderPass.setBindGroup(1, objectBindGroup);

    // Bind group 2: Wireframe uniforms
    const wireframeBindGroup = device.createBindGroup({
      label: 'test_wireframe_bindgroup',
      layout: this.wireframeBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.wireframeUniformBuffer } }],
    });
    renderPass.setBindGroup(2, wireframeBindGroup);

    // Activar position buffer del mesh (activate configura buffer 0)
    mesh.activate(renderPass);

    // Sobrescribir el index buffer con nuestras aristas
    renderPass.setIndexBuffer(edgeIndexBuffer, 'uint16');

    renderPass.drawIndexed(edgeIndices.length);

    renderPass.end();
    device.queue.submit([encoder.finish()]);

    // Limpiar buffers temporales
    objectUniformBuffer.destroy();
    edgeIndexBuffer.destroy();
  }

  // ==================== Material Inspector ====================

  /**
   * Called once when the editor GUI becomes visible.
   * Builds a "Material Inspector" window with sliders bound via .listen() to _matProxy.
   * The proxy values are synced in update() whenever the selection changes — lil-gui
   * auto-refreshes the displayed values so no folder rebuild is needed.
   */
  public override renderInMenu(): void {
    const gui = Engine.getGUI();
    if (!gui.getIsVisible()) return;
    if (!gui.beginWindow('Material Inspector')) return; // only runs once per editor session

    const folder = gui.getFolder('Material Inspector');
    if (!folder) return;
    folder.open();

    // ── Read-only info ────────────────────────────────────────────────────────
    (folder as any).add(this._matProxy, 'meshName').name('Mesh').disable().listen();
    (folder as any).add(this._matProxy, 'materialName').name('Material').disable().listen();
    (folder as any).add(this._matProxy, 'technique').name('Technique').disable().listen();

    // ── UV tiling ─────────────────────────────────────────────────────────────
    (folder as any)
      .add(this._matProxy, 'uvXScale', 0.1, 50, 0.1)
      .name('UV Scale X')
      .listen()
      .onChange((v: number) => this.getCurrentMaterial()?.setFactors({ uvXScale: v }));
    (folder as any)
      .add(this._matProxy, 'uvYScale', 0.1, 50, 0.1)
      .name('UV Scale Y')
      .listen()
      .onChange((v: number) => this.getCurrentMaterial()?.setFactors({ uvYScale: v }));

    // ── PBR factors ───────────────────────────────────────────────────────────
    (folder as any)
      .add(this._matProxy, 'roughnessFactor', 0, 2, 0.01)
      .name('Roughness')
      .listen()
      .onChange((v: number) => this.getCurrentMaterial()?.setFactors({ roughnessFactor: v }));
    (folder as any)
      .add(this._matProxy, 'metallicFactor', 0, 1, 0.01)
      .name('Metallic')
      .listen()
      .onChange((v: number) => this.getCurrentMaterial()?.setFactors({ metallicFactor: v }));
    (folder as any)
      .add(this._matProxy, 'emissiveFactor', 0, 5, 0.05)
      .name('Emissive')
      .listen()
      .onChange((v: number) => this.getCurrentMaterial()?.setFactors({ emissiveFactor: v }));

    // ── Blending ──────────────────────────────────────────────────────────────
    (folder as any)
      .add(this._matProxy, 'appearanceBlend', 0, 1, 0.01)
      .name('Appearance Blend')
      .listen()
      .onChange((v: number) => this.getCurrentMaterial()?.setFactors({ appearanceBlend: v }));
    (folder as any)
      .add(this._matProxy, 'surfaceBlend', 0, 1, 0.01)
      .name('Surface Blend')
      .listen()
      .onChange((v: number) => this.getCurrentMaterial()?.setFactors({ surfaceBlend: v }));

    // ── POM ───────────────────────────────────────────────────────────────────
    (folder as any)
      .add(this._matProxy, 'pomScale', 0, 0.2, 0.001)
      .name('POM Scale')
      .listen()
      .onChange((v: number) => this.getCurrentMaterial()?.setFactors({ pomScale: v }));
  }

  /**
   * Syncs the _matProxy object from the currently selected entity's first material part.
   * Called every frame in update(); early-returns if the selection hasn't changed.
   */
  private refreshMaterialInspector(): void {
    if (this._lastInspectedEntity === this.selectedEntity) return;
    this._lastInspectedEntity = this.selectedEntity;

    const mat = this.getCurrentMaterial();
    if (!mat) {
      this._matProxy.meshName = '— none —';
      this._matProxy.materialName = '— none —';
      this._matProxy.technique = '— none —';
      this._matProxy.pomScale = 0;
      this._matProxy.roughnessFactor = 1;
      this._matProxy.metallicFactor = 1;
      this._matProxy.emissiveFactor = 1;
      this._matProxy.uvXScale = 1;
      this._matProxy.uvYScale = 1;
      this._matProxy.appearanceBlend = 1;
      this._matProxy.surfaceBlend = 1;
      return;
    }

    const rc = this.selectedEntity!.getComponent('render') as RenderComponent | null;
    const firstPart = rc?.getParts()?.[0];
    this._matProxy.meshName = firstPart?.mesh?.path?.split('/').pop() ?? '—';
    this._matProxy.materialName = mat.getName().split('/').pop() ?? mat.getName();
    this._matProxy.technique = mat.getTechnique()?.path?.split('/').pop() ?? '—';
    this._matProxy.pomScale = mat.getPomScale();
    this._matProxy.roughnessFactor = mat.getRoughnessFactor();
    this._matProxy.metallicFactor = mat.getMetallicFactor();
    this._matProxy.emissiveFactor = mat.getEmissiveFactor();
    this._matProxy.uvXScale = mat.getUvXScale();
    this._matProxy.uvYScale = mat.getUvYScale();
    this._matProxy.appearanceBlend = mat.getAppearanceBlend();
    this._matProxy.surfaceBlend = mat.getSurfaceBlend();
  }

  /** Returns the Material from the first visible render part of the selected entity, or null. */
  private getCurrentMaterial(): Material | null {
    if (!this.selectedEntity) return null;
    const rc = this.selectedEntity.getComponent('render') as RenderComponent | null;
    const parts = rc?.getParts();
    if (!parts || parts.length === 0) return null;
    return parts[0]?.material ?? null;
  }

  public getSelectedEntity(): Entity | null {
    return this.selectedEntity;
  }

  public getSelectedEntity(): Entity | null {
    return this.selectedEntity;
  }

  public getHoveredEntity(): Entity | null {
    return this.hoveredEntity;
  }

  // ==================== Probe helpers ====================

  /** Returns true if the entity has a reflection_probe component. */
  private isProbeEntity(entity: Entity): boolean {
    return entity.hasComponent('reflection_probe');
  }

  /**
   * Ray-to-point distance test against all probe entities.
   * Uses a screen-space adaptive threshold (~15px) so picking works at any distance.
   * No occlusion guard — probes should always be selectable in the editor.
   */
  private findProbeEntityAtRay(
    rayOrigin: vec3,
    rayDir: vec3,
    camera: import('../../core/math/Camera').Camera,
  ): Entity | null {
    const probeList =
      Engine.getEntities().getObjectManagerByName('reflection_probe')?.getList() ?? [];

    // Screen-space pick radius in pixels → world-space threshold at depth t.
    // worldThreshold = t * tan(fovY/2) * (PICK_PX * 2 / viewportHeight)
    const PICK_PX = 15;
    const fovY = camera.getFov(); // radians
    const viewportHeight = camera.getViewport().height;
    const fovFactor = Math.tan(fovY / 2) * ((PICK_PX * 2) / viewportHeight);

    let closest: Entity | null = null;
    let closestT = Infinity;

    for (const comp of probeList) {
      const entity: Entity = (comp as any).getOwner();
      const transformComp = entity.getComponent('transform') as TransformComponent;
      if (!transformComp) continue;

      const center = transformComp.getTransform().getWorldPosition();

      // t = signed distance along ray to closest point to center
      const toCam = vec3.create();
      vec3.subtract(toCam, center, rayOrigin);
      const t = vec3.dot(toCam, rayDir);
      if (t <= 0) continue; // behind camera

      // Perpendicular distance from ray to center
      const closestPt = vec3.scaleAndAdd(vec3.create(), rayOrigin, rayDir, t);
      const perpDist = vec3.distance(closestPt, center);

      // World-space threshold grows with depth → constant screen-space feel
      const worldThreshold = t * fovFactor;

      if (perpDist < worldThreshold && t < closestT) {
        closestT = t;
        closest = entity;
      }
    }

    return closest;
  }

  /** Renders the probe volume box + face handles using GizmoRenderer. */
  private renderProbeVolume(): void {
    if (!this.selectedEntity) return;
    const transformComp = this.selectedEntity.getComponent('transform') as TransformComponent;
    const boxComp = this.selectedEntity.getComponent('box_collider') as BoxColliderComponent;
    const camera = this.getEditorCamera();
    if (!transformComp || !boxComp || !camera) return;

    const center = transformComp.getTransform().getWorldPosition();
    const half = boxComp.getHalfExtents();
    const hoveredHandle =
      this.gizmoMode === GizmoMode.PROBE_RESIZE ? this.probeHoveredHandle : GizmoAxis.NONE;

    this.gizmoRenderer.renderProbeBox(center, half, camera.getCamera(), hoveredHandle);
  }

  // ==================== Probe resize drag ====================

  /**
   * Starts a probe face resize drag.
   * `face` is one of PROBE_PX … PROBE_NZ.
   */
  private startProbeFaceDrag(
    face: GizmoAxis,
    center: vec3,
    halfExtents: vec3,
    mousePos: { x: number; y: number },
    camera: CameraComponent,
  ): void {
    this.isDragging = true;
    this.probeDragFace = face;
    this._probeDragStartHalfExtents = vec3.clone(halfExtents);

    // Face center = point on the face being dragged
    const faceCenter = vec3.clone(center);
    switch (face) {
      case GizmoAxis.PROBE_PX:
        faceCenter[0] += halfExtents[0];
        break;
      case GizmoAxis.PROBE_NX:
        faceCenter[0] -= halfExtents[0];
        break;
      case GizmoAxis.PROBE_PY:
        faceCenter[1] += halfExtents[1];
        break;
      case GizmoAxis.PROBE_NY:
        faceCenter[1] -= halfExtents[1];
        break;
      case GizmoAxis.PROBE_PZ:
        faceCenter[2] += halfExtents[2];
        break;
      case GizmoAxis.PROBE_NZ:
        faceCenter[2] -= halfExtents[2];
        break;
    }
    this._probeDragStartFaceCenter = faceCenter;

    // Drag plane at the face center, normal = face axis direction
    const axisDir = this.probeFaceToAxisDir(face);
    const cameraDir = camera.getCamera().getFront();
    vec3.cross(this.dragPlaneNormal, axisDir, cameraDir);
    vec3.cross(this.dragPlaneNormal, this.dragPlaneNormal, axisDir);
    vec3.normalize(this.dragPlaneNormal, this.dragPlaneNormal);
    vec3.copy(this.dragPlanePoint, faceCenter);
    vec3.copy(this.dragStartWorldPos, faceCenter);
    this.dragStartMousePos = { ...mousePos };
    this.draggedAxis = GizmoAxis.NONE; // not a translate drag
  }

  private probeFaceToAxisDir(face: GizmoAxis): vec3 {
    switch (face) {
      case GizmoAxis.PROBE_PX:
        return vec3.fromValues(1, 0, 0);
      case GizmoAxis.PROBE_NX:
        return vec3.fromValues(-1, 0, 0);
      case GizmoAxis.PROBE_PY:
        return vec3.fromValues(0, 1, 0);
      case GizmoAxis.PROBE_NY:
        return vec3.fromValues(0, -1, 0);
      case GizmoAxis.PROBE_PZ:
        return vec3.fromValues(0, 0, 1);
      case GizmoAxis.PROBE_NZ:
        return vec3.fromValues(0, 0, -1);
      default:
        return vec3.fromValues(0, 1, 0);
    }
  }

  /**
   * Processes an active probe face resize drag.
   * Called from processDragging() when probeDragFace !== NONE.
   */
  private processProbeFaceDrag(): void {
    if (!this.selectedEntity || !this._probeDragStartHalfExtents || !this._probeDragStartFaceCenter)
      return;

    const camera = this.getEditorCamera();
    if (!camera) return;

    const input = Engine.getInput();
    const mousePos = input.getMousePosition();
    const ray = this.screenToWorldRay(mousePos, camera);

    const hitPoint = this.rayPlaneIntersection(
      ray.origin,
      ray.direction,
      this.dragPlanePoint,
      this.dragPlaneNormal,
    );
    if (!hitPoint) return;

    const axisDir = this.probeFaceToAxisDir(this.probeDragFace);
    const isNeg =
      this.probeDragFace === GizmoAxis.PROBE_NX ||
      this.probeDragFace === GizmoAxis.PROBE_NY ||
      this.probeDragFace === GizmoAxis.PROBE_NZ;

    // How far has the face moved along its outward direction?
    const dragVec = vec3.create();
    vec3.subtract(dragVec, hitPoint, this._probeDragStartFaceCenter);
    // For negative faces, convert sign so "pulling out" = positive delta
    let delta = vec3.dot(dragVec, axisDir) * (isNeg ? -1 : 1);

    // Snap to 0.1 m
    delta = Math.round(delta / 0.1) * 0.1;

    const startH = this._probeDragStartHalfExtents;
    const axisIdx = axisDir[0] !== 0 ? 0 : axisDir[1] !== 0 ? 1 : 2;
    const newHalfExtents = vec3.clone(startH);
    newHalfExtents[axisIdx] = Math.max(0.1, startH[axisIdx] + delta);

    const boxComp = this.selectedEntity.getComponent('box_collider') as BoxColliderComponent;
    if (!boxComp) return;

    const newSize = vec3.fromValues(
      newHalfExtents[0] * 2,
      newHalfExtents[1] * 2,
      newHalfExtents[2] * 2,
    );
    boxComp.resizeBox(newSize);

    // Keep ReflectionProbeComponent.extents in sync
    const probeComp = this.selectedEntity.getComponent(
      'reflection_probe',
    ) as ReflectionProbeComponent;
    if (probeComp) {
      probeComp.setExtents(newHalfExtents);
    }
  }

  /**
   * Procesa el arrastre durante el movimiento del mouse
   */
  private processDragging(): void {
    if (!this.selectedEntity) return;

    // Route to probe face resize if active
    if (this.probeDragFace !== GizmoAxis.NONE) {
      this.processProbeFaceDrag();
      return;
    }

    const camera = this.getEditorCamera();
    if (!camera) return;

    const input = Engine.getInput();
    const mousePos = input.getMousePosition();

    // Crear rayo desde posición actual del mouse
    const ray = this.screenToWorldRay(mousePos, camera);

    // Intersectar rayo con plano de arrastre
    const hitPoint = this.rayPlaneIntersection(
      ray.origin,
      ray.direction,
      this.dragPlanePoint,
      this.dragPlaneNormal,
    );

    if (!hitPoint) return;

    // Proyectar el hit point en el eje de arrastre
    const axisDir = vec3.create();
    switch (this.draggedAxis) {
      case GizmoAxis.X:
        vec3.set(axisDir, 1, 0, 0);
        break;
      case GizmoAxis.Y:
        vec3.set(axisDir, 0, 1, 0);
        break;
      case GizmoAxis.Z:
        vec3.set(axisDir, 0, 0, 1);
        break;
    }

    // Calcular desplazamiento a lo largo del eje
    const dragVector = vec3.create();
    vec3.subtract(dragVector, hitPoint, this.dragStartWorldPos);
    let displacement = vec3.dot(dragVector, axisDir);

    // --- SNAPPING ---
    const SNAP_STEP = 0.2;
    displacement = Math.round(displacement / SNAP_STEP) * SNAP_STEP;

    // Obtener el modo de gizmo actual
    if (this.gizmoMode === GizmoMode.SCALE) {
      // Escalado en el eje correspondiente
      const transformComp = this.selectedEntity.getComponent('transform') as TransformComponent;
      if (transformComp) {
        // Obtener escala inicial
        const startScale = vec3.clone(transformComp.getTransform().getLocalScale());
        // El valor base de escala en el eje es el valor inicial al comenzar el drag
        // Para mantener la escala acumulativa, almacenamos el valor inicial al comenzar el drag
        if (!this._dragStartScale) {
          this._dragStartScale = vec3.clone(startScale);
        }
        const dragStartScale = this._dragStartScale;

        // El desplazamiento se traduce en un factor multiplicativo
        // Por ejemplo, 0 desplazamiento = 1.0, positivo = mayor, negativo = menor
        // Aquí usamos: factor = 1 + desplazamiento
        // Clamp para evitar escala negativa o cero
        let factor = 1 + displacement;
        factor = Math.max(0.05, factor);

        // Nueva escala usando axisDir
        const newScale = vec3.clone(dragStartScale);
        // Aplicar el factor solo en la dirección de axisDir
        // newScale = dragStartScale + axisDir * (dragStartScale * (factor - 1))
        // Para cada componente:
        for (let i = 0; i < 3; ++i) {
          // Si axisDir[i] es 1, escalar ese eje; si es 0, dejar igual
          if (Math.abs(axisDir[i]) > 0.5) {
            newScale[i] = dragStartScale[i] * factor;
          } else {
            newScale[i] = dragStartScale[i];
          }
          // Clamp para evitar valores negativos o muy pequeños
          newScale[i] = Math.max(0.05, newScale[i]);
        }
        transformComp.getTransform().setLocalScale(newScale);
      }
    } else {
      // TRANSLATE (comportamiento original)
      const transformComp = this.selectedEntity.getComponent('transform') as TransformComponent;
      if (transformComp) {
        const newPos = vec3.create();
        vec3.scaleAndAdd(newPos, this.dragStartWorldPos, axisDir, displacement);
        transformComp.getTransform().setLocalPosition(newPos);
        // Sincronizar collider físico si existe y es cinemático
        const collider =
          this.selectedEntity.getComponent('box_collider') ||
          this.selectedEntity.getComponent('sphere_collider') ||
          this.selectedEntity.getComponent('capsule_collider') ||
          this.selectedEntity.getComponent('mesh_collider');
        if (
          collider &&
          typeof collider.getRigidBody === 'function' &&
          typeof collider.getBodyType === 'function'
        ) {
          const bodyType = collider.getBodyType();
          if (bodyType === 'kinematic' || bodyType === 2) {
            collider
              .getRigidBody()
              .setNextKinematicTranslation({ x: newPos[0], y: newPos[1], z: newPos[2] });
          } else if (bodyType === 'static' || bodyType === 0) {
            collider
              .getRigidBody()
              .setTranslation({ x: newPos[0], y: newPos[1], z: newPos[2] }, true);
          }
        }
      }
    }
  }

  /** Logs the current probe transform + collider size to the console. */
  private logProbeProperties(): void {
    if (!this.selectedEntity || !this.isProbeEntity(this.selectedEntity)) return;
    const transformComp = this.selectedEntity.getComponent('transform') as TransformComponent;
    const boxComp = this.selectedEntity.getComponent('box_collider') as BoxColliderComponent;
    if (!transformComp) return;

    const t = transformComp.getTransform();
    const pos = t.getLocalPosition();
    const rot = t.getLocalRotation(); // quaternion [x,y,z,w]
    const scl = t.getLocalScale();
    const name =
      (this.selectedEntity.getComponent('name') as any)?.getName?.() ?? this.selectedEntity.getId();

    const round = (v: number) => Math.round(v * 10000) / 10000;
    const fmtVec3 = (v: ArrayLike<number>) => `[${round(v[0])}, ${round(v[1])}, ${round(v[2])}]`;
    const fmtVec4 = (v: ArrayLike<number>) =>
      `[${round(v[0])}, ${round(v[1])}, ${round(v[2])}, ${round(v[3])}]`;

    console.group(`%c📍 Probe: ${name}`, 'color:#7eb8f7;font-weight:bold');
    console.log(`  "position": ${fmtVec3(pos)},`);
    console.log(`  "rotation": ${fmtVec4(rot)},`);
    console.log(`  "scale":    ${fmtVec3(scl)},`);
    if (boxComp) {
      const half = boxComp.getHalfExtents();
      const size = [round(half[0] * 2), round(half[1] * 2), round(half[2] * 2)];
      console.log(
        `  "box_collider": { "isSensor": true, "bodyType": "static", "size": [${size.join(', ')}] }`,
      );
    }
    console.groupEnd();
  }

  /**
   * Detiene el arrastre
   */
  private stopDragging(): void {
    this.isDragging = false;

    // Clear probe face drag state
    if (this.probeDragFace !== GizmoAxis.NONE) {
      this.probeDragFace = GizmoAxis.NONE;
      this._probeDragStartHalfExtents = null;
      this._probeDragStartFaceCenter = null;
      this.draggedAxis = GizmoAxis.NONE;
      this.logProbeProperties();
      return;
    }

    // Log probe properties after translate/scale drag
    if (this.selectedEntity && this.isProbeEntity(this.selectedEntity)) {
      this.logProbeProperties();
    }
    // Si se acaba de hacer drag de escala, recrear el collider si existe
    if (this.gizmoMode === GizmoMode.SCALE && this.selectedEntity) {
      const transformComp = this.selectedEntity.getComponent('transform') as TransformComponent;
      const newScale = transformComp?.getTransform().getLocalScale();
      // Buscar collider
      const collider =
        this.selectedEntity.getComponent('box_collider') ||
        this.selectedEntity.getComponent('sphere_collider') ||
        this.selectedEntity.getComponent('capsule_collider') ||
        this.selectedEntity.getComponent('mesh_collider');
      if (
        collider &&
        typeof collider.getRigidBody === 'function' &&
        typeof collider.getCollider === 'function'
      ) {
        const rigidBody = collider.getRigidBody();
        const oldCollider = collider.getCollider();
        // Quitar el collider anterior del mundo
        const world = Engine.getPhysics().getWorld();
        world.removeCollider(oldCollider, true);
        // Crear nuevo collider con el tamaño actualizado
        // Ejemplo para box_collider:
        if (collider.type === 'box_collider') {
          // Asume que tienes una función para crear el collider, por ejemplo collider.createCollider()
          const newCollider = collider.createCollider({
            halfExtents: [newScale[0] * 0.5, newScale[1] * 0.5, newScale[2] * 0.5],
            rigidBody,
          });
          // Adjuntar al rigidbody
          rigidBody.addCollider(newCollider);
          collider.setCollider(newCollider);
        }
        // Para otros tipos, deberías adaptar el constructor y los parámetros
      }
    }
    // Limpiar escala inicial de drag para futuros drags
    this._dragStartScale = null;
    this.draggedAxis = GizmoAxis.NONE;
  }

  /**
   * Calcula la intersección entre un rayo y un plano
   * @returns Punto de intersección o null si no hay intersección
   */
  private rayPlaneIntersection(
    rayOrigin: vec3,
    rayDir: vec3,
    planePoint: vec3,
    planeNormal: vec3,
  ): vec3 | null {
    const denom = vec3.dot(planeNormal, rayDir);

    // Si el rayo es paralelo al plano
    if (Math.abs(denom) < 0.0001) {
      return null;
    }

    const p0l0 = vec3.create();
    vec3.subtract(p0l0, planePoint, rayOrigin);
    const t = vec3.dot(p0l0, planeNormal) / denom;

    // Si la intersección está detrás del rayo
    if (t < 0) {
      return null;
    }

    const hitPoint = vec3.create();
    vec3.scaleAndAdd(hitPoint, rayOrigin, rayDir, t);
    return hitPoint;
  }
}
