import { Module } from '../core/Module';
import { Engine } from '../../core/engine/Engine';
import { Entity } from '../../core/ecs/Entity';
import { CameraComponent } from '../../components/render/CameraComponent';
import { vec3, mat4 } from 'gl-matrix';
import { MouseButton } from '../../types/MouseButton.enum';
import { RenderComponent } from '../../components/render/RenderComponent';
import { TransformComponent } from '../../components/core/TransformComponent';
import { WireframeMeshGenerator } from '../../utils/WireframeMeshGenerator';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { Render } from '../../renderer/core/pipeline/Render';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { Mesh } from '../../renderer/resources/Mesh';

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

    // Crear bind group para wireframe uniforms
    this.wireframeBindGroup = device.createBindGroup({
      label: 'wireframe_uniforms_bindgroup',
      layout: this.wireframeBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.wireframeUniformBuffer },
        },
      ],
    });

    // Cargar mesh del unit cube
    this.cubeMesh = await Mesh.get('cube.obj');

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

    console.log('ModuleEditorSelection stopped');
  }

  public update(dt: number): void {
    const input = Engine.getInput();

    // Click izquierdo para seleccionar
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

    // Convertir a NDC (-1 to 1)
    const x = (mousePos.x / canvas.width) * 2 - 1;
    const y = -((mousePos.y / canvas.height) * 2 - 1); // Y invertido

    // Ray en clip space
    const rayClip = vec3.fromValues(x, y, -1);

    // Invertir projection matrix
    const projInverse = mat4.create();
    mat4.invert(projInverse, camera.getProjection());

    // Ray en view space
    const rayView = vec3.create();
    vec3.transformMat4(rayView, rayClip, projInverse);
    rayView[2] = -1; // Forward en view space
    vec3.normalize(rayView, rayView);

    // Invertir view matrix
    const viewInverse = mat4.create();
    mat4.invert(viewInverse, camera.getView());

    // Ray origin (camera position)
    const origin = vec3.create();
    mat4.getTranslation(origin, viewInverse);

    // Ray direction en world space
    const direction = vec3.create();
    vec3.transformMat4(direction, rayView, viewInverse);
    vec3.subtract(direction, direction, origin);
    vec3.normalize(direction, direction);

    return { origin, direction };
  }

  public renderDebug(): void {
    // Renderizar wireframe del hovered entity (verde)
    if (this.hoveredEntity && this.selectedEntity !== this.hoveredEntity) {
      this.renderWireframeInFrame(this.hoveredEntity, [0.0, 10.0, 0.0, 1.0]);
    }

    // Renderizar wireframe del selected entity (rojo) si es diferente al hover
    if (this.selectedEntity) {
      this.renderWireframeInFrame(this.selectedEntity, [10.0, 0.0, 0.0, 1.0]);
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
}
