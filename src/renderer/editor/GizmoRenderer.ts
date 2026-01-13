import { vec3 } from 'gl-matrix';
import { GPUUtils } from '../core/utils/GPUUtils';
import { Render } from '../core/pipeline/Render';
import { GizmoMode } from '../../types/GizmoMode.enum';
import { GizmoAxis } from '../../types/GizmoAxis.enum';
import { Camera } from '../../core/math/Camera';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';

/**
 * GizmoRenderer - Renderiza gizmos de transformación (translate, rotate, scale)
 * Similar a los gizmos de Unity/Blender
 */
export class GizmoRenderer {
  private device: GPUDevice;

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

  constructor() {
    this.device = GPUUtils.getDevice();
  }

  public async initialize(): Promise<void> {
    await this.createPipeline();
    this.createUniformBuffers();
    this.createVertexBuffer();
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
   * Detecta qué eje del gizmo está en hover dado un rayo desde la cámara
   * @param gizmoPosition - Posición del gizmo en world space
   * @param rayOrigin - Origen del rayo (posición de cámara)
   * @param rayDirection - Dirección normalizada del rayo
   * @param scale - Escala efectiva del gizmo
   * @returns El eje en hover o NONE
   */
  public detectHover(
    gizmoPosition: vec3,
    rayOrigin: vec3,
    rayDirection: vec3,
    scale: number = 1.0,
  ): GizmoAxis {
    const effectiveScale = scale * this.gizmoScale;
    let closestAxis = GizmoAxis.NONE;
    let minDistance = this.hoverThreshold;

    // Definir los tres ejes
    const axes = [
      { dir: vec3.fromValues(1, 0, 0), axis: GizmoAxis.X },
      { dir: vec3.fromValues(0, 1, 0), axis: GizmoAxis.Y },
      { dir: vec3.fromValues(0, 0, 1), axis: GizmoAxis.Z },
    ];
    for (const { dir, axis } of axes) {
      // Calcular punto final del eje
      const axisEnd = vec3.create();
      vec3.scaleAndAdd(axisEnd, gizmoPosition, dir, this.axisLength * effectiveScale);

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
  private calculateAdaptiveScale(
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
  }
}
