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

export class ModuleEditorSelection extends Module {
  private selectedEntity: Entity | null = null;
  private hoveredEntity: Entity | null = null;
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
    const vsCode = await ResourceManager.loadShader('wireframe.vs');
    const fsCode = await ResourceManager.loadShader('wireframe.fs');

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
          // Buffer 0: Position
          {
            arrayStride: 3 * 4, // vec3<f32>
            attributes: [
              {
                shaderLocation: 0,
                offset: 0,
                format: 'float32x3',
              },
            ],
          },
          // Buffer 1: Barycentric
          {
            arrayStride: 3 * 4, // vec3<f32>
            attributes: [
              {
                shaderLocation: 1,
                offset: 0,
                format: 'float32x3',
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
  }

  /**
   * Cambia el modo de gizmo (TRANSLATE, SCALE, ROTATE, ...)
   */
  private cycleGizmoMode(): void {
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

    // 1. Primero verificar si se hizo clic en el gizmo (si hay objeto seleccionado)
    if (this.selectedEntity) {
      const transformComp = this.selectedEntity.getComponent('transform') as TransformComponent;
      if (transformComp) {
        const gizmoPosition = transformComp.getTransform().getWorldPosition();
        const clickedAxis = this.gizmoRenderer.detectHover(
          gizmoPosition,
          ray.origin,
          ray.direction,
          this.gizmoScale,
        );

        // Si se hizo clic en un eje del gizmo, iniciar arrastre
        if (clickedAxis !== GizmoAxis.NONE) {
          this.startDragging(clickedAxis, gizmoPosition, mousePos, camera);
          return;
        }
      }
    }

    // 2. Si no se hizo clic en el gizmo, hacer selección normal
    // Usar el módulo de physics para hacer raycast (ignora sensores, selecciona el más cercano)
    const physics = Engine.getPhysics();
    const result = physics.raycastClosestNonSensor(ray.origin, ray.direction, 10000.0);

    if (result) {
      const entity = Engine.getEntities().getEntityById(result.entityId);

      if (entity && entity !== this.selectedEntity) {
        this.selectedEntity = entity;
      }
    } else {
      // No hit - deseleccionar
      if (this.selectedEntity) {
        this.selectedEntity = null;
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

    // Convertir mouse position a ray en world space
    const ray = this.screenToWorldRay(mousePos, camera);

    // 1. Primero verificar hover sobre el gizmo (si hay objeto seleccionado)
    if (this.selectedEntity) {
      const transformComp = this.selectedEntity.getComponent('transform') as TransformComponent;
      if (transformComp) {
        const gizmoPosition = transformComp.getTransform().getWorldPosition();
        const hoveredAxis = this.gizmoRenderer.detectHover(
          gizmoPosition,
          ray.origin,
          ray.direction,
          this.gizmoScale,
        );

        // Actualizar el estado de hover del gizmo
        this.gizmoRenderer.setHoveredAxis(hoveredAxis);

        // Si hay hover sobre el gizmo, no detectar hover sobre entidades
        if (hoveredAxis !== GizmoAxis.NONE) {
          this.hoveredEntity = null;
          return;
        }
      }
    }

    // 2. Si no hay hover sobre el gizmo, detectar hover sobre entidades
    // Usar el módulo de physics para hacer raycast (ignora sensores, selecciona el más cercano)
    const physics = Engine.getPhysics();
    const result = physics.raycastClosestNonSensor(ray.origin, ray.direction, 10000.0);

    const newHoveredEntity = result ? Engine.getEntities().getEntityById(result.entityId) : null;

    // Solo actualizar si cambió el hover
    if (newHoveredEntity !== this.hoveredEntity) {
      // Log de cambio de hover (opcional, para debug)
      if (newHoveredEntity) {
      }

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
    // Renderizar wireframe del hovered entity (verde)
    if (this.hoveredEntity && this.selectedEntity !== this.hoveredEntity) {
      this.renderWireframeInFrame(this.hoveredEntity, [0.0, 10.0, 0.0, 1.0]);
    }

    // Renderizar wireframe del selected entity (rojo)
    if (this.selectedEntity) {
      this.renderWireframeInFrame(this.selectedEntity, [10.0, 0.0, 0.0, 1.0]);

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

    // Renderizar según el modo activo
    switch (this.gizmoMode) {
      case GizmoMode.TRANSLATE:
        this.gizmoRenderer.renderTranslateGizmo(position, camera.getCamera(), this.gizmoScale);
        break;
      // TODO: Implementar ROTATE y SCALE
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

  public getSelectedEntity(): Entity | null {
    return this.selectedEntity;
  }

  public getHoveredEntity(): Entity | null {
    return this.hoveredEntity;
  }

  /**
   * Procesa el arrastre durante el movimiento del mouse
   */
  private processDragging(): void {
    if (!this.selectedEntity) return;

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

    // Aplicar desplazamiento al objeto
    const transformComp = this.selectedEntity.getComponent('transform') as TransformComponent;
    if (transformComp) {
      const newPos = vec3.create();
      vec3.scaleAndAdd(newPos, this.dragStartWorldPos, axisDir, displacement);

      // Actualizar posición
      transformComp.getTransform().setLocalPosition(newPos);

      // Sincronizar collider físico si existe y es cinemático
      // Buscar collider por nombres comunes
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
          // 2 = RigidBodyType.KINEMATIC
          // Obtener rotación actual
          collider
            .getRigidBody()
            .setNextKinematicTranslation({ x: newPos[0], y: newPos[1], z: newPos[2] });
        } else if (bodyType === 'static' || bodyType === 0) {
          // 0 = RigidBodyType.STATIC
          collider
            .getRigidBody()
            .setTranslation({ x: newPos[0], y: newPos[1], z: newPos[2] }, true);
        }
      }
    }
  }

  /**
   * Detiene el arrastre
   */
  private stopDragging(): void {
    this.isDragging = false;
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
