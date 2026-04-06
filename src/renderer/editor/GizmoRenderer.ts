import { vec3, mat4 } from 'gl-matrix';
import { GPUUtils } from '../core/utils/GPUUtils';
import { Render } from '../core/pipeline/Render';
import { GizmoAxis } from '../../types/GizmoAxis.enum';
import { Camera } from '../../core/math/Camera';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { Transform } from '../../core/math/Transform';

/**
 * GizmoRenderer - Renderiza gizmos de transformación (translate, rotate, scale)
 * Similar a los gizmos de Unity/Blender
 */
export class GizmoRenderer {
  private device: GPUDevice;

  // Pipeline para renderizar triángulos (semi-transparent fill)
  private fillPipeline!: GPURenderPipeline;

  // Probe box geometry buffers
  private probeVertexBuffer!: GPUBuffer;
  private probeEdgeColorBuffer!: GPUBuffer;
  private probeFillColorBuffer!: GPUBuffer;
  private probeHandleDefaultBuffer!: GPUBuffer;
  private probeHandleHoveredBuffer!: GPUBuffer;
  private probeEdgeColorBindGroup!: GPUBindGroup;
  private probeFillColorBindGroup!: GPUBindGroup;
  private probeHandleDefaultBindGroup!: GPUBindGroup;
  private probeHandleHoveredBindGroup!: GPUBindGroup;

  // Probe box vertex budget:
  //  - 36 filled triangles (fill pass)
  //  - 24 wireframe edge verts (line pass)
  //  - 24 face-handle cross verts (line pass)
  //  = 84 verts max, store in one buffer; passes select offset/count
  private static readonly PROBE_FILL_VERT_COUNT = 36;
  private static readonly PROBE_EDGE_VERT_COUNT = 24;
  private static readonly PROBE_HANDLE_VERT_COUNT = 24; // 6 handles × 4 verts (2 lines × 2)
  private static readonly PROBE_TOTAL_VERT_COUNT = 84;

  // Pipeline para renderizar líneas
  private linePipeline!: GPURenderPipeline;

  // Bind group layouts
  private cameraBindGroupLayout!: GPUBindGroupLayout;
  private uniformBindGroupLayout!: GPUBindGroupLayout;

  // Buffers para uniforms (color) - uno por eje
  private uniformBufferX!: GPUBuffer;
  private uniformBufferY!: GPUBuffer;
  private uniformBufferZ!: GPUBuffer;
  private uniformBindGroupX!: GPUBindGroup;
  private uniformBindGroupY!: GPUBindGroup;
  private uniformBindGroupZ!: GPUBindGroup;

  // Vertex buffers reutilizables
  private vertexBuffer!: GPUBuffer;
  private maxVertices: number = 64; // Máximo número de vértices

  // Configuración
  private gizmoScale: number = 1.0; // Escala base del gizmo
  private axisLength: number = 1.0; // Longitud de cada eje
  private hoveredAxis: GizmoAxis = GizmoAxis.NONE;
  private hoverThreshold: number = 0.1; // Distancia mínima para considerar hover (world space)

  // Store the current transform for object-space gizmo axes
  private _currentTransform: Transform | null = null;

  public get currentTransform(): Transform | null {
    return this._currentTransform;
  }

  public set currentTransform(value: Transform | null) {
    this._currentTransform = value;
  }

  constructor() {
    this.device = GPUUtils.getDevice();
  }

  public async initialize(): Promise<void> {
    await this.createPipeline();
    this.createUniformBuffers();
    this.createVertexBuffer();
    this.createProbeBuffers();
    console.log('✅ GizmoRenderer initialized');
  }

  private async createPipeline(): Promise<void> {
    const device = this.device;

    // Shader simple para líneas coloreadas
    const shaderCode = `
      struct CameraUniforms {
        viewMatrix: mat4x4<f32>,
        projectionMatrix: mat4x4<f32>,
        invViewProjection: mat4x4<f32>,
        cameraPosition: vec3<f32>,
        screenSize: vec2<f32>,
        cameraFront: vec3<f32>,
        cameraZFar: f32,
        invProjection: mat4x4<f32>,
      };

      struct GizmoUniforms {
        color: vec4<f32>,
      };

      @group(0) @binding(0) var<uniform> camera: CameraUniforms;
      @group(1) @binding(0) var<uniform> gizmo: GizmoUniforms;

      struct VertexInput {
        @location(0) position: vec3<f32>,
      };

      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec4<f32>,
      };

      @vertex
      fn vs_main(in: VertexInput) -> VertexOutput {
        var out: VertexOutput;
        let viewPos = camera.viewMatrix * vec4<f32>(in.position, 1.0);
        out.position = camera.projectionMatrix * viewPos;
        out.color = gizmo.color;
        return out;
      }

      @fragment
      fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
        return in.color;
      }
    `;

    const shaderModule = device.createShaderModule({
      label: 'gizmo_shader',
      code: shaderCode,
    });

    // Camera bind group layout (shared with rest of engine)
    this.cameraBindGroupLayout = BindGroupFactory.getCameraUniformsLayout();

    // Gizmo uniform layout (color)
    this.uniformBindGroupLayout = device.createBindGroupLayout({
      label: 'gizmo_uniform_layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'gizmo_pipeline_layout',
      bindGroupLayouts: [this.cameraBindGroupLayout, this.uniformBindGroupLayout],
    });

    // Pipeline para líneas
    this.linePipeline = device.createRenderPipeline({
      label: 'gizmo_line_pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
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
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: 'bgra8unorm',
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
        topology: 'line-list',
        cullMode: 'none',
      },
    });

    // Pipeline para triángulos (relleno semitransparente de volumes de probe)
    this.fillPipeline = device.createRenderPipeline({
      label: 'gizmo_fill_pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 3 * 4,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: 'bgra8unorm',
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
        topology: 'triangle-list',
        cullMode: 'none',
      },
    });
  }

  private createUniformBuffers(): void {
    // Crear 3 buffers para los colores de cada eje
    const createColorBuffer = (label: string, color: number[]): GPUBuffer => {
      const buffer = this.device.createBuffer({
        label,
        size: 16, // vec4<f32>
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(buffer, 0, new Float32Array(color));
      return buffer;
    };

    this.uniformBufferX = createColorBuffer('gizmo_uniform_X', [1.0, 0.0, 0.0, 1.0]); // Rojo
    this.uniformBufferY = createColorBuffer('gizmo_uniform_Y', [0.0, 1.0, 0.0, 1.0]); // Verde
    this.uniformBufferZ = createColorBuffer('gizmo_uniform_Z', [0.0, 0.0, 1.0, 1.0]); // Azul

    // Crear bind groups
    this.uniformBindGroupX = this.device.createBindGroup({
      label: 'gizmo_uniform_bindgroup_X',
      layout: this.uniformBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBufferX } }],
    });

    this.uniformBindGroupY = this.device.createBindGroup({
      label: 'gizmo_uniform_bindgroup_Y',
      layout: this.uniformBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBufferY } }],
    });

    this.uniformBindGroupZ = this.device.createBindGroup({
      label: 'gizmo_uniform_bindgroup_Z',
      layout: this.uniformBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBufferZ } }],
    });
  }

  private createVertexBuffer(): void {
    // Crear buffer reutilizable para vértices
    this.vertexBuffer = this.device.createBuffer({
      label: 'gizmo_vertex_buffer',
      size: this.maxVertices * 3 * 4, // vec3<f32> per vertex
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Renderiza un gizmo de traslación (3 ejes: X, Y, Z)
   */
  public renderTranslateGizmo(position: vec3, camera: Camera, scale: number = 1.0): void {
    // Calcular escala adaptativa basada en distancia a cámara
    const cameraPosition = camera.getPosition();
    const adaptiveScale = this.calculateAdaptiveScale(position, cameraPosition, scale);
    const effectiveScale = adaptiveScale * this.gizmoScale;
    const device = this.device;

    // Preparar todos los vértices de una vez (6 vértices = 3 líneas × 2 puntos)
    const allVertices = new Float32Array(18); // 6 vertices × 3 floats
    let offset = 0;

    // Calcular vértices para cada eje
    const axes = [
      { dir: vec3.fromValues(1, 0, 0), axis: GizmoAxis.X, color: [1.0, 0.0, 0.0, 1.0] }, // X - Rojo
      { dir: vec3.fromValues(0, 1, 0), axis: GizmoAxis.Y, color: [0.0, 1.0, 0.0, 1.0] }, // Y - Verde
      { dir: vec3.fromValues(0, 0, 1), axis: GizmoAxis.Z, color: [0.0, 0.0, 1.0, 1.0] }, // Z - Azul
    ];

    for (const { dir } of axes) {
      const end = vec3.create();
      vec3.scaleAndAdd(end, position, dir, this.axisLength * effectiveScale);

      // Start point
      allVertices[offset++] = position[0];
      allVertices[offset++] = position[1];
      allVertices[offset++] = position[2];

      // End point
      allVertices[offset++] = end[0];
      allVertices[offset++] = end[1];
      allVertices[offset++] = end[2];
    }

    // Escribir todos los vértices al buffer de una vez
    device.queue.writeBuffer(this.vertexBuffer, 0, allVertices);

    // Crear command encoder y render pass una sola vez
    const encoder = device.createCommandEncoder({ label: 'gizmo_encoder' });
    const renderPass = encoder.beginRenderPass({
      label: 'gizmo_render_pass',
      colorAttachments: [
        {
          view: Render.getInstance().getContext().getCurrentTexture().createView(),
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });

    renderPass.setPipeline(this.linePipeline);
    renderPass.setBindGroup(0, camera.getBindGroup());
    renderPass.setVertexBuffer(0, this.vertexBuffer);

    // Renderizar cada eje con su bind group correspondiente (con hover)
    const bindGroups = [this.uniformBindGroupX, this.uniformBindGroupY, this.uniformBindGroupZ];
    const uniformBuffers = [this.uniformBufferX, this.uniformBufferY, this.uniformBufferZ];

    for (let i = 0; i < 3; i++) {
      const { axis } = axes[i]!;

      // Si este eje está en hover, actualizar su color a brillante
      if (this.hoveredAxis === axis) {
        const brightColor = this.brightenColor(axes[i]!.color);
        device.queue.writeBuffer(uniformBuffers[i]!, 0, new Float32Array(brightColor));
      } else {
        // Restaurar color original
        device.queue.writeBuffer(uniformBuffers[i]!, 0, new Float32Array(axes[i]!.color));
      }

      // Bind color para este eje
      renderPass.setBindGroup(1, bindGroups[i]!);

      // Draw line (2 vertices starting at vertex offset i*2)
      renderPass.draw(2, 1, i * 2, 0);
    }

    renderPass.end();
    device.queue.submit([encoder.finish()]);
  }

  /**
   * Renderiza el gizmo de escala (cubos en los extremos de los ejes)
   */
  public renderScaleGizmo(position: vec3, camera: Camera, scale: number = 1.0): void {
    // Calcular escala adaptativa basada en distancia a cámara
    const cameraPosition = camera.getPosition();
    const adaptiveScale = this.calculateAdaptiveScale(position, cameraPosition, scale);
    const effectiveScale = adaptiveScale * this.gizmoScale;
    const device = this.device;

    // Obtener la rotación del objeto en world space (como matriz)
    // Se espera que el usuario pase la rotación (quat o mat4) si quiere ejes en object space
    // Por compatibilidad, intentamos obtenerla de this._currentTransform si existe
    // Pero aquí, para mantener la API, pedimos que se setee antes de llamar a renderScaleGizmo
    // Si no, los ejes serán world space
    let rotationMatrix: mat4 | null = null;
    if (this._currentTransform && typeof this._currentTransform.getWorldRotation === 'function') {
      const rot = this._currentTransform.getWorldRotation();
      rotationMatrix = mat4.create();
      mat4.fromQuat(rotationMatrix, rot);
    }

    // Ejes y colores
    const axes = [
      { dir: vec3.fromValues(1, 0, 0), axis: GizmoAxis.X, color: [1.0, 0.0, 0.0, 1.0] },
      { dir: vec3.fromValues(0, 1, 0), axis: GizmoAxis.Y, color: [0.0, 1.0, 0.0, 1.0] },
      { dir: vec3.fromValues(0, 0, 1), axis: GizmoAxis.Z, color: [0.0, 0.0, 1.0, 1.0] },
    ];

    // Dibujar líneas de los ejes en object space
    const allVertices = new Float32Array(18); // 6 vertices × 3 floats
    let offset = 0;
    for (const { dir } of axes) {
      let axisDir = vec3.clone(dir);
      if (rotationMatrix) {
        vec3.transformMat4(axisDir, axisDir, rotationMatrix);
      }
      const end = vec3.create();
      vec3.scaleAndAdd(end, position, axisDir, this.axisLength * effectiveScale);
      // Start point
      allVertices[offset++] = position[0];
      allVertices[offset++] = position[1];
      allVertices[offset++] = position[2];
      // End point
      allVertices[offset++] = end[0];
      allVertices[offset++] = end[1];
      allVertices[offset++] = end[2];
    }
    device.queue.writeBuffer(this.vertexBuffer, 0, allVertices);

    // Renderizar líneas
    const encoder = device.createCommandEncoder({ label: 'gizmo_encoder_scale' });
    const renderPass = encoder.beginRenderPass({
      label: 'gizmo_render_pass_scale',
      colorAttachments: [
        {
          view: Render.getInstance().getContext().getCurrentTexture().createView(),
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });
    renderPass.setPipeline(this.linePipeline);
    renderPass.setBindGroup(0, camera.getBindGroup());
    renderPass.setVertexBuffer(0, this.vertexBuffer);

    const bindGroups = [this.uniformBindGroupX, this.uniformBindGroupY, this.uniformBindGroupZ];
    const uniformBuffers = [this.uniformBufferX, this.uniformBufferY, this.uniformBufferZ];
    for (let i = 0; i < 3; i++) {
      const { axis } = axes[i]!;
      // Color hover
      if (this.hoveredAxis === axis) {
        const brightColor = this.brightenColor(axes[i]!.color);
        device.queue.writeBuffer(uniformBuffers[i]!, 0, new Float32Array(brightColor));
      } else {
        device.queue.writeBuffer(uniformBuffers[i]!, 0, new Float32Array(axes[i]!.color));
      }
      renderPass.setBindGroup(1, bindGroups[i]!);
      renderPass.draw(2, 1, i * 2, 0);
    }

    renderPass.end();
    device.queue.submit([encoder.finish()]);
  }

  /**
   * Detecta qué eje del gizmo está en hover dado un rayo desde la cámara
   * @param gizmoPosition - Posición del gizmo en world space
   * @param rayOrigin - Origen del rayo (posición de cámara)
   * @param rayDirection - Dirección normalizada del rayo
   * @param scale - Escala efectiva del gizmo
   * @returns El eje en hover o NONE
   */
  /**
   * Detecta qué eje del gizmo está en hover dado un rayo desde la cámara
   * @param gizmoPosition - Posición del gizmo en world space
   * @param rayOrigin - Origen del rayo (posición de cámara)
   * @param rayDirection - Dirección normalizada del rayo
   * @param scale - Escala efectiva del gizmo
   * @param useObjectSpaceAxes - Si true, aplica la rotación del objeto (modo SCALE)
   */
  public detectHover(
    gizmoPosition: vec3,
    rayOrigin: vec3,
    rayDirection: vec3,
    scale: number = 1.0,
    useObjectSpaceAxes: boolean = false,
  ): GizmoAxis {
    const effectiveScale = scale * this.gizmoScale;
    let closestAxis = GizmoAxis.NONE;
    let minDistance = this.hoverThreshold;

    // Solo aplicar rotación si se solicita (modo SCALE)
    let rotationMatrix: mat4 | null = null;
    if (
      useObjectSpaceAxes &&
      this._currentTransform &&
      typeof this._currentTransform.getWorldRotation === 'function'
    ) {
      const rot = this._currentTransform.getWorldRotation();
      rotationMatrix = mat4.create();
      mat4.fromQuat(rotationMatrix, rot);
    }

    const axes = [
      { dir: vec3.fromValues(1, 0, 0), axis: GizmoAxis.X },
      { dir: vec3.fromValues(0, 1, 0), axis: GizmoAxis.Y },
      { dir: vec3.fromValues(0, 0, 1), axis: GizmoAxis.Z },
    ];
    for (const { dir, axis } of axes) {
      let axisDir = vec3.clone(dir);
      if (rotationMatrix) {
        vec3.transformMat4(axisDir, axisDir, rotationMatrix);
      }
      // Calcular punto final del eje
      const axisEnd = vec3.create();
      vec3.scaleAndAdd(axisEnd, gizmoPosition, axisDir, this.axisLength * effectiveScale);

      // Calcular distancia mínima entre rayo y segmento de línea
      const distance = this.rayToSegmentDistance(rayOrigin, rayDirection, gizmoPosition, axisEnd);
      if (distance < minDistance) {
        minDistance = distance;
        closestAxis = axis;
      }
    }

    return closestAxis;
  }

  /**
   * Calcula la distancia mínima entre un rayo y un segmento de línea
   * @param rayOrigin - Origen del rayo
   * @param rayDir - Dirección del rayo (normalizada)
   * @param segmentStart - Inicio del segmento
   * @param segmentEnd - Fin del segmento
   * @returns Distancia mínima
   */
  private rayToSegmentDistance(
    rayOrigin: vec3,
    rayDir: vec3,
    segmentStart: vec3,
    segmentEnd: vec3,
  ): number {
    // Vector del segmento
    const segmentVec = vec3.create();
    vec3.subtract(segmentVec, segmentEnd, segmentStart);

    // Vector desde inicio del segmento al origen del rayo
    const w0 = vec3.create();
    vec3.subtract(w0, rayOrigin, segmentStart);

    const a = vec3.dot(rayDir, rayDir); // Siempre 1 si rayDir está normalizado
    const b = vec3.dot(rayDir, segmentVec);
    const c = vec3.dot(segmentVec, segmentVec);
    const d = vec3.dot(rayDir, w0);
    const e = vec3.dot(segmentVec, w0);

    const denominator = a * c - b * b;

    let sc: number, tc: number;

    if (denominator < 0.00001) {
      // Rayo y segmento son paralelos
      sc = 0.0;
      tc = d / b;
    } else {
      sc = (b * e - c * d) / denominator;
      tc = (a * e - b * d) / denominator;
    }

    // Clampear tc al segmento [0, 1]
    tc = Math.max(0, Math.min(1, tc));

    // Calcular los puntos más cercanos
    const pointOnRay = vec3.create();
    vec3.scaleAndAdd(pointOnRay, rayOrigin, rayDir, sc);

    const pointOnSegment = vec3.create();
    vec3.scaleAndAdd(pointOnSegment, segmentStart, segmentVec, tc);

    // Distancia entre los puntos
    return vec3.distance(pointOnRay, pointOnSegment);
  }

  /**
   * Aumenta el brillo de un color para hover mezclando con blanco
   */
  private brightenColor(color: number[]): number[] {
    // Mezclar más con blanco para que se note claramente
    const mixFactor = 0.2; // 40% del color original
    const whiteMix = 1.0 - mixFactor; // 60% de blanco

    return [
      color[0]! * mixFactor + whiteMix,
      color[1]! * mixFactor + whiteMix,
      color[2]! * mixFactor + whiteMix,
      color[3]!,
    ];
  }

  /**
   * Establece qué eje está en hover
   */
  public setHoveredAxis(axis: GizmoAxis): void {
    this.hoveredAxis = axis;
  }

  /**
   * Obtiene el eje actualmente en hover
   */
  public getHoveredAxis(): GizmoAxis {
    return this.hoveredAxis;
  }

  /**
   * Establece la escala base del gizmo
   */
  public setGizmoScale(scale: number): void {
    this.gizmoScale = scale;
  }

  /**
   * Calcula la escala adaptativa del gizmo basada en la distancia a la cámara
   * para mantener un tamaño visual constante en pantalla
   * @param gizmoPosition - Posición del gizmo en world space
   * @param cameraPosition - Posición de la cámara
   * @param baseScale - Escala base (opcional)
   * @returns Escala adaptativa calculada
   */
  public calculateAdaptiveScale(
    gizmoPosition: vec3,
    cameraPosition: vec3,
    baseScale: number = 1.0,
  ): number {
    // Calcular distancia entre gizmo y cámara
    const distance = vec3.distance(gizmoPosition, cameraPosition);

    // Factor de escala basado en distancia
    // A mayor distancia, mayor escala para mantener tamaño visual constante
    // Factor de 0.15 ajusta la relación distancia/escala
    const adaptiveScale = distance * 0.15;

    // Aplicar escala base
    return adaptiveScale * baseScale;
  }

  public destroy(): void {
    this.uniformBufferX?.destroy();
    this.uniformBufferY?.destroy();
    this.uniformBufferZ?.destroy();
    this.vertexBuffer?.destroy();
    this.probeVertexBuffer?.destroy();
    this.probeEdgeColorBuffer?.destroy();
    this.probeFillColorBuffer?.destroy();
    this.probeHandleDefaultBuffer?.destroy();
    this.probeHandleHoveredBuffer?.destroy();
  }

  // ==================== Probe box ====================

  private createProbeBuffers(): void {
    const device = this.device;

    this.probeVertexBuffer = device.createBuffer({
      label: 'probe_box_vertices',
      size: GizmoRenderer.PROBE_TOTAL_VERT_COUNT * 3 * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    const mkBuf = (label: string, color: number[]): GPUBuffer => {
      const buf = device.createBuffer({
        label,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, new Float32Array(color));
      return buf;
    };
    const mkBG = (label: string, buf: GPUBuffer): GPUBindGroup =>
      device.createBindGroup({
        label,
        layout: this.uniformBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: buf } }],
      });

    this.probeFillColorBuffer = mkBuf('probe_fill_color', [0.0, 0.8, 0.8, 0.12]);
    this.probeEdgeColorBuffer = mkBuf('probe_edge_color', [0.0, 0.95, 0.95, 0.9]);
    this.probeHandleDefaultBuffer = mkBuf('probe_handle_def', [1.0, 0.9, 0.0, 1.0]);
    this.probeHandleHoveredBuffer = mkBuf('probe_handle_hov', [1.0, 1.0, 1.0, 1.0]);

    this.probeFillColorBindGroup = mkBG('probe_fill_bg', this.probeFillColorBuffer);
    this.probeEdgeColorBindGroup = mkBG('probe_edge_bg', this.probeEdgeColorBuffer);
    this.probeHandleDefaultBindGroup = mkBG('probe_handle_def_bg', this.probeHandleDefaultBuffer);
    this.probeHandleHoveredBindGroup = mkBG('probe_handle_hov_bg', this.probeHandleHoveredBuffer);
  }

  /**
   * Builds the 8 corners of an AABB box.
   * Corner index layout:
   *  0: (-hx,-hy,-hz)  1: (+hx,-hy,-hz)  2: (+hx,-hy,+hz)  3: (-hx,-hy,+hz)
   *  4: (-hx,+hy,-hz)  5: (+hx,+hy,-hz)  6: (+hx,+hy,+hz)  7: (-hx,+hy,+hz)
   */
  private buildBoxCorners(center: vec3, half: vec3): vec3[] {
    const [cx, cy, cz] = [center[0], center[1], center[2]];
    const [hx, hy, hz] = [half[0], half[1], half[2]];
    return [
      vec3.fromValues(cx - hx, cy - hy, cz - hz),
      vec3.fromValues(cx + hx, cy - hy, cz - hz),
      vec3.fromValues(cx + hx, cy - hy, cz + hz),
      vec3.fromValues(cx - hx, cy - hy, cz + hz),
      vec3.fromValues(cx - hx, cy + hy, cz - hz),
      vec3.fromValues(cx + hx, cy + hy, cz - hz),
      vec3.fromValues(cx + hx, cy + hy, cz + hz),
      vec3.fromValues(cx - hx, cy + hy, cz + hz),
    ];
  }

  /**
   * Writes 36 positions for a filled box into `out` starting at `offset`.
   * Returns next offset.
   */
  private writeFilledBox(out: Float32Array, offset: number, c: vec3[]): number {
    // 6 faces × 2 triangles × 3 verts
    const faces: [number, number, number, number][] = [
      [0, 1, 2, 3], // bottom (Y-)
      [7, 6, 5, 4], // top    (Y+)
      [3, 2, 6, 7], // front  (Z+)
      [0, 4, 5, 1], // back   (Z-)
      [0, 3, 7, 4], // left   (X-)
      [1, 5, 6, 2], // right  (X+)
    ];
    for (const [a, b, d_, e] of faces) {
      // Triangle 1: a, b, d
      out[offset++] = c[a]![0];
      out[offset++] = c[a]![1];
      out[offset++] = c[a]![2];
      out[offset++] = c[b]![0];
      out[offset++] = c[b]![1];
      out[offset++] = c[b]![2];
      out[offset++] = c[d_]![0];
      out[offset++] = c[d_]![1];
      out[offset++] = c[d_]![2];
      // Triangle 2: a, d, e
      out[offset++] = c[a]![0];
      out[offset++] = c[a]![1];
      out[offset++] = c[a]![2];
      out[offset++] = c[d_]![0];
      out[offset++] = c[d_]![1];
      out[offset++] = c[d_]![2];
      out[offset++] = c[e]![0];
      out[offset++] = c[e]![1];
      out[offset++] = c[e]![2];
    }
    return offset;
  }

  /**
   * Writes 24 positions for the 12 wireframe edges into `out` starting at `offset`.
   */
  private writeBoxEdges(out: Float32Array, offset: number, c: vec3[]): number {
    const edges: [number, number][] = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0], // bottom ring
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 4], // top ring
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7], // verticals
    ];
    for (const [a, b] of edges) {
      out[offset++] = c[a]![0];
      out[offset++] = c[a]![1];
      out[offset++] = c[a]![2];
      out[offset++] = c[b]![0];
      out[offset++] = c[b]![1];
      out[offset++] = c[b]![2];
    }
    return offset;
  }

  /**
   * Writes 4 positions for a face cross marker (2 perpendicular lines) into `out`.
   * Returns [startIndex, nextOffset] so we can draw by handle.
   */
  private writeFaceCross(
    out: Float32Array,
    offset: number,
    faceCenter: vec3,
    tangU: vec3,
    tangV: vec3,
    size: number,
  ): number {
    // Line 1 along tangU
    out[offset++] = faceCenter[0] - tangU[0] * size;
    out[offset++] = faceCenter[1] - tangU[1] * size;
    out[offset++] = faceCenter[2] - tangU[2] * size;
    out[offset++] = faceCenter[0] + tangU[0] * size;
    out[offset++] = faceCenter[1] + tangU[1] * size;
    out[offset++] = faceCenter[2] + tangU[2] * size;
    // Line 2 along tangV
    out[offset++] = faceCenter[0] - tangV[0] * size;
    out[offset++] = faceCenter[1] - tangV[1] * size;
    out[offset++] = faceCenter[2] - tangV[2] * size;
    out[offset++] = faceCenter[0] + tangV[0] * size;
    out[offset++] = faceCenter[1] + tangV[1] * size;
    out[offset++] = faceCenter[2] + tangV[2] * size;
    return offset;
  }

  /**
   * Renders the probe volume as:
   *  1. A semi-transparent filled box (alpha ~0.12)
   *  2. A cyan wireframe outline
   *  3. Six face cross-handles (yellow, white if hovered)
   */
  public renderProbeBox(
    center: vec3,
    halfExtents: vec3,
    camera: Camera,
    hoveredHandle: GizmoAxis = GizmoAxis.NONE,
  ): void {
    const device = this.device;
    const corners = this.buildBoxCorners(center, halfExtents);

    const verts = new Float32Array(GizmoRenderer.PROBE_TOTAL_VERT_COUNT * 3);
    let off = 0;

    // [0..35] filled box triangles (36 vertices)
    off = this.writeFilledBox(verts, off, corners);

    // [36..59] wireframe edges (24 vertices)
    off = this.writeBoxEdges(verts, off, corners);

    // [60..83] face handle crosses (24 vertices, 4 per handle in order PX,NX,PY,NY,PZ,NZ)
    const cs = Math.min(halfExtents[0], halfExtents[1], halfExtents[2]) * 0.15 + 0.05;
    const xDir = vec3.fromValues(1, 0, 0);
    const yDir = vec3.fromValues(0, 1, 0);
    const zDir = vec3.fromValues(0, 0, 1);
    const handles: { center: vec3; u: vec3; v: vec3 }[] = [
      {
        center: vec3.fromValues(center[0] + halfExtents[0], center[1], center[2]),
        u: yDir,
        v: zDir,
      }, // PX
      {
        center: vec3.fromValues(center[0] - halfExtents[0], center[1], center[2]),
        u: yDir,
        v: zDir,
      }, // NX
      {
        center: vec3.fromValues(center[0], center[1] + halfExtents[1], center[2]),
        u: xDir,
        v: zDir,
      }, // PY
      {
        center: vec3.fromValues(center[0], center[1] - halfExtents[1], center[2]),
        u: xDir,
        v: zDir,
      }, // NY
      {
        center: vec3.fromValues(center[0], center[1], center[2] + halfExtents[2]),
        u: xDir,
        v: yDir,
      }, // PZ
      {
        center: vec3.fromValues(center[0], center[1], center[2] - halfExtents[2]),
        u: xDir,
        v: yDir,
      }, // NZ
    ];
    for (const h of handles) {
      off = this.writeFaceCross(verts, off, h.center, h.u, h.v, cs);
    }

    device.queue.writeBuffer(this.probeVertexBuffer, 0, verts);

    const encoder = device.createCommandEncoder({ label: 'probe_box_encoder' });
    const renderPass = encoder.beginRenderPass({
      label: 'probe_box_pass',
      colorAttachments: [
        {
          view: Render.getInstance().getContext().getCurrentTexture().createView(),
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });

    const camBG = camera.getBindGroup();
    renderPass.setVertexBuffer(0, this.probeVertexBuffer);

    // 1. Filled box (semi-transparent)
    renderPass.setPipeline(this.fillPipeline);
    renderPass.setBindGroup(0, camBG);
    renderPass.setBindGroup(1, this.probeFillColorBindGroup);
    renderPass.draw(GizmoRenderer.PROBE_FILL_VERT_COUNT, 1, 0, 0);

    // 2. Wireframe edges
    renderPass.setPipeline(this.linePipeline);
    renderPass.setBindGroup(1, this.probeEdgeColorBindGroup);
    renderPass.draw(GizmoRenderer.PROBE_EDGE_VERT_COUNT, 1, GizmoRenderer.PROBE_FILL_VERT_COUNT, 0);

    // 3. Face handle crosses
    const handleAxes: GizmoAxis[] = [
      GizmoAxis.PROBE_PX,
      GizmoAxis.PROBE_NX,
      GizmoAxis.PROBE_PY,
      GizmoAxis.PROBE_NY,
      GizmoAxis.PROBE_PZ,
      GizmoAxis.PROBE_NZ,
    ];
    const handleBase = GizmoRenderer.PROBE_FILL_VERT_COUNT + GizmoRenderer.PROBE_EDGE_VERT_COUNT;
    for (let i = 0; i < 6; i++) {
      const bg =
        hoveredHandle === handleAxes[i]
          ? this.probeHandleHoveredBindGroup
          : this.probeHandleDefaultBindGroup;
      renderPass.setBindGroup(1, bg);
      renderPass.draw(4, 1, handleBase + i * 4, 0); // 4 verts = 2 lines
    }

    renderPass.end();
    device.queue.submit([encoder.finish()]);
  }

  /**
   * Tests a world-space ray against the 6 face handle points of the probe box.
   * Returns the closest hovered GizmoAxis or NONE.
   */
  public detectProbeHandleHover(
    center: vec3,
    halfExtents: vec3,
    rayOrigin: vec3,
    rayDirection: vec3,
  ): GizmoAxis {
    const handleDefs: { pos: vec3; axis: GizmoAxis }[] = [
      {
        pos: vec3.fromValues(center[0] + halfExtents[0], center[1], center[2]),
        axis: GizmoAxis.PROBE_PX,
      },
      {
        pos: vec3.fromValues(center[0] - halfExtents[0], center[1], center[2]),
        axis: GizmoAxis.PROBE_NX,
      },
      {
        pos: vec3.fromValues(center[0], center[1] + halfExtents[1], center[2]),
        axis: GizmoAxis.PROBE_PY,
      },
      {
        pos: vec3.fromValues(center[0], center[1] - halfExtents[1], center[2]),
        axis: GizmoAxis.PROBE_NY,
      },
      {
        pos: vec3.fromValues(center[0], center[1], center[2] + halfExtents[2]),
        axis: GizmoAxis.PROBE_PZ,
      },
      {
        pos: vec3.fromValues(center[0], center[1], center[2] - halfExtents[2]),
        axis: GizmoAxis.PROBE_NZ,
      },
    ];

    let closest = GizmoAxis.NONE;
    let minDist = 0.4; // world-space threshold

    for (const { pos, axis } of handleDefs) {
      const dist = this.rayPointDistance(rayOrigin, rayDirection, pos);
      if (dist < minDist) {
        minDist = dist;
        closest = axis;
      }
    }
    return closest;
  }

  private rayPointDistance(rayOrigin: vec3, rayDir: vec3, point: vec3): number {
    const toPoint = vec3.create();
    vec3.subtract(toPoint, point, rayOrigin);
    const t = Math.max(0, vec3.dot(toPoint, rayDir));
    const closest = vec3.create();
    vec3.scaleAndAdd(closest, rayOrigin, rayDir, t);
    return vec3.distance(closest, point);
  }
}
