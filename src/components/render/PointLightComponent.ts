import { vec3, vec4 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Render } from '../../renderer/core/Render';
import { Technique } from '../../renderer/resources/Technique';
import { TransformComponent } from '../core/TransformComponent';

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

  public async load(data: unknown): Promise<void> {
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

    this.uniformBuffer = Render.getInstance()
      .getDevice()
      .createBuffer({
        label: `point light uniform buffer`,
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

    this.uniformBindGroup = Render.getInstance()
      .getDevice()
      .createBindGroup({
        label: `point light uniform bind group`,
        layout: this.technique.getPipeline().getBindGroupLayout(3),
        entries: [
          {
            binding: 0,
            resource: { buffer: this.uniformBuffer },
          },
        ],
      });
  }

  public setBindGroup(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(3, this.uniformBindGroup); // point light parameters
  }

  public update(dt: number): void {
    if (this.isDirty) {
      const entity = this.getOwner();
      const transform = entity.getComponent('transform') as TransformComponent;
      transform
        .getTransform()
        .setLocalScale(vec3.fromValues(this.radius, this.radius, this.radius));
      vec3.copy(this.position, transform.getTransform().getWorldPosition());

      const render = Render.getInstance();
      render
        .getDevice()
        .queue.writeBuffer(
          this.uniformBuffer,
          0,
          new Float32Array([
            this.position[0],
            this.position[1],
            this.position[2],
            0.0,
            this.color[0],
            this.color[1],
            this.color[2],
            this.color[3],
            this.intensity,
            this.radius,
            0.0,
            0.0,
          ]),
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
