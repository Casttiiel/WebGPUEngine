import { vec3, vec4 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Technique } from '../../renderer/resources/Technique';
import { TransformComponent } from '../core/TransformComponent';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { PointLightComponentData } from '../../types/PointLightComponentData.type';

export class PointLightComponent extends Component {
  private color = vec4.create();
  private position = vec3.create();
  private intensity = 1.0;
  private radius = 1.0;
  private isDirty = true;

  private uniformBindGroup!: GPUBindGroup;
  private uniformBuffer!: GPUBuffer;

  private technique!: Technique;

  constructor() {
    super();
  }

  public async load(data: PointLightComponentData): Promise<void> {
    if (data.color) {
      vec4.copy(this.color, data.color);
    }

    if (data.intensity) {
      this.intensity = data.intensity;
    }

    if (data.radius) {
      this.radius = data.radius;
    }

    this.technique = await Technique.get('point_light.tech');
    this.uniformBuffer = GPUUtils.createBuffer(
      'point light uniform buffer',
      28 * 4,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    this.uniformBindGroup = BindGroupFactory.createBindGroup(
      `point light uniform bind group`,
      this.technique.getPipeline().getBindGroupLayout(3)!,
      [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
    );
  }

  public setBindGroup(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(3, this.uniformBindGroup); // point light parameters
  }

  public update(_dt: number): void {
    if (this.isDirty) {
      const entity = this.getOwner();
      const transform = entity.getComponent('transform') as TransformComponent;
      transform
        .getTransform()
        .setLocalScale(vec3.fromValues(this.radius + 1.0, this.radius + 1.0, this.radius + 1.0));
      vec3.copy(this.position, transform.getTransform().getWorldPosition());

      GPUUtils.writeBuffer(this.uniformBuffer, 0, new Float32Array(this.color));
      GPUUtils.writeBuffer(
        this.uniformBuffer,
        16,
        new Float32Array(
          vec4.fromValues(this.position[0], this.position[1], this.position[2], this.intensity),
        ),
      );

      GPUUtils.writeBuffer(
        this.uniformBuffer,
        96,
        new Float32Array(vec4.fromValues(this.radius, 0.0, 0.0, 0.0)),
      );
      this.isDirty = false;
    }
  }

  public debugInMenu(): void {
    // Implement debug menu if needed
  }

  public renderDebug(): void {
    // Implement debug rendering if needed
  }
}
