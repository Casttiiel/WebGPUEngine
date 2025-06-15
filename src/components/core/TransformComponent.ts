import { vec3 } from 'gl-matrix';
import { Transform } from '../../core/math/Transform';
import { Component } from '../../core/ecs/Component';
import { TransformComponentDataType } from '../../types/TransformComponentData.type';
import { Render } from '../../renderer/core/Render';

export class TransformComponent extends Component {
  private transform: Transform;
  private uniformBuffer!: GPUBuffer;
  private modelBindGroup!: GPUBindGroup;

  constructor() {
    super();
    const device = Render.getInstance().getDevice();
    this.transform = new Transform();

    // Crear buffer uniforme para la model matrix
    this.uniformBuffer = device.createBuffer({
      label: `transform_uniformBuffer`,
      size: 16 * 4, // 1 matriz 4x4 (model)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Layout para la matriz de modelo
    const modelBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
      ],
    });

    // Bind group para la matriz de modelo
    this.modelBindGroup = device.createBindGroup({
      label: `transform_modelBindGroup`,
      layout: modelBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
    });
  }

  public async load(data: TransformComponentDataType): Promise<void> {
    if (data.position) {
      this.transform.setLocalPosition(data.position);
    }

    if (data.rotation) {
      this.transform.setAngles(data.rotation[1], data.rotation[0], data.rotation[2]);
    }

    if (data.scale) {
      const scale = vec3.fromValues(data.scale[0] ?? 1, data.scale[1] ?? 1, data.scale[2] ?? 1);
      this.transform.setLocalScale(scale);
    }

    this.updateWorldTransform();
    this.updateModelMatrix();
  }

  private updateWorldTransform(): void {
    const entity = this.getOwner();
    const parent = entity.getParent();

    if (parent) {
      const parentTransform = parent.getComponent('transform') as TransformComponent;
      if (parentTransform) {
        this.transform.updateWorldTransform(parentTransform.getTransform());
      } else {
        this.transform.updateWorldTransform();
      }
    } else {
      this.transform.updateWorldTransform();
    }
  }

  private updateModelMatrix(): void {
    const device = Render.getInstance().getDevice();
    device.queue.writeBuffer(
      this.uniformBuffer,
      0,
      new Float32Array(this.transform.getWorldMatrix()),
    );
  }

  private updateChildrenTransforms(): void {
    const entity = this.getOwner();
    const children = entity.getChildren();

    for (const child of children) {
      const transformComponent = child.getComponent('transform') as TransformComponent;
      if (transformComponent) {
        transformComponent.updateWorldTransform();
        transformComponent.updateModelMatrix();
        transformComponent.updateChildrenTransforms();
      }
    }
  }

  public update(dt: number): void {
    this.updateWorldTransform();
    this.updateModelMatrix();
    this.updateChildrenTransforms();
  }

  public override renderInMenu(): void {
    // Implement if needed
  }

  public renderDebug(): void {
    // Transform debug visualization could be implemented here
    // For example, showing axis gizmos
  }

  public getTransform(): Transform {
    return this.transform;
  }

  public getModelBindGroup(): GPUBindGroup {
    return this.modelBindGroup;
  }
}
