import { vec3, vec4, mat4 } from 'gl-matrix';
import { Technique } from '../../renderer/resources/Technique';
import { CameraComponent } from './CameraComponent';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';

export class SpotLightComponent extends CameraComponent {
  private color = vec4.create();
  private position = vec3.create();
  private intensity = 1.0;
  private radius = 1.0;

  private uniformBindGroup!: GPUBindGroup;
  private uniformBuffer!: GPUBuffer;
  private modelUniformBuffer!: GPUBuffer;
  private modelBindGroup!: GPUBindGroup;

  private technique!: Technique;

  constructor() {
    super();
  }

  public override async load(data: unknown): Promise<void> {
    if (data.color) {
      vec4.copy(this.color, data.color);
    }

    if (data.intensity) {
      this.intensity = data.intensity;
    }

    if (data.radius) {
      this.radius = data.radius;
    }

    if (data.near) {
      this.camera.setNearPlane(data.near);
    }

    if (data.far) {
      this.camera.setFarPlane(data.far);
    }

    if (data.fov) {
      this.camera.setFov(data.fov);
    }

    if (data.viewport) {
      this.camera.setViewport(data.viewport.width, data.viewport.height);
    }

    if (data.isOrtho) {
      this.camera.setOrthoParams(
        data.orthoCentered || true,
        data.orthoLeft,
        data.orthoWidth,
        data.orthoTop,
        data.orthoHeight,
      );
    }

    const position = data.position || [0, 0, 0];
    const target = data.target || [0, 0, 1];
    const up = data.up || [0, 1, 0];
    this.camera.lookAt(position, target, up);

    this.technique = await Technique.get('spot_light.tech');
    this.uniformBuffer = GPUUtils.createBuffer(
      'spot light uniform buffer',
      28 * 4,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    );
    this.uniformBindGroup = BindGroupFactory.createBindGroup(
      `spot light uniform bind group`,
      this.technique.getPipeline().getBindGroupLayout(3)!,
      [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ]
    );

    GPUUtils.writeBuffer(this.uniformBuffer, 0, new Float32Array(this.color));
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      16,
      new Float32Array(
        vec4.fromValues(this.position[0], this.position[1], this.position[2], this.intensity),
      ),
    );

    // Calculate LightViewProjOffset matrix
    const mtx_scale = mat4.create();
    const mtx_translation = mat4.create();
    const mtx_offset = mat4.create();
    const lightViewProjOffset = mat4.create();

    mat4.scale(mtx_scale, mat4.create(), [0.5, -0.5, 1.0]);
    mat4.translate(mtx_translation, mat4.create(), [0.5, 0.5, 0.0]);
    mat4.multiply(mtx_offset, mtx_scale, mtx_translation);
    mat4.multiply(lightViewProjOffset, this.camera.getViewProjection(), mtx_offset);

    GPUUtils.writeBuffer(this.uniformBuffer, 32, new Float32Array(this.camera.getViewProjection()));
    GPUUtils.writeBuffer(
      this.uniformBuffer,
      96,
      new Float32Array(vec4.fromValues(this.radius, 0.0, 0.0, 0.0)),
    ); const modelBindGroupLayout = BindGroupFactory.getLayoutFromEnum(
      PipelineBindGroupLayouts.OBJECT_UNIFORMS
    );

    this.modelUniformBuffer = GPUUtils.createBuffer(
      'spot_light_transform_uniformBuffer',
      16 * 4, // 1 matriz 4x4 (model)
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    );
    const res = mat4.create();
    mat4.invert(res, this.camera.getViewProjection());
    GPUUtils.writeBuffer(this.modelUniformBuffer, 0, new Float32Array(res));

    // Bind group para la matriz de modelo
    this.modelBindGroup = BindGroupFactory.createBindGroup(
      `transform_modelBindGroup`,
      modelBindGroupLayout,
      [
        {
          binding: 0,
          resource: { buffer: this.modelUniformBuffer },
        },
      ]
    );
  }

  public setBindGroup(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(2, this.modelBindGroup); //for model matrix
    pass.setBindGroup(3, this.uniformBindGroup); // spot light parameters
  }

  public override update(_dt: number): void { }

  public debugInMenu(): void {
    // Implement debug menu if needed
  }

  public override renderDebug(): void {
    // Implement debug rendering if needed
  }
}
