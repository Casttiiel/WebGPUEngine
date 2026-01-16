import { vec3 } from 'gl-matrix';
import { Transform } from '../../core/math/Transform';
import { Component } from '../../core/ecs/Component';
import { TransformComponentDataType } from '../../types/TransformComponentData.type';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';
import { InstanceManager } from '../../renderer/core/managers/InstanceManager';
import { RenderComponent } from '../render/RenderComponent';

export class TransformComponent extends Component {
  private transform: Transform;
  private uniformBuffer!: GPUBuffer;
  private modelBindGroup!: GPUBindGroup;

  constructor() {
    super();
    this.transform = new Transform();

    // Crear buffer uniforme para la model matrix
    this.uniformBuffer = GPUUtils.createBuffer(
      'transform_uniformBuffer',
      16 * 4, // 1 matriz 4x4 (model)
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Layout para la matriz de modelo
    const modelBindGroupLayout = BindGroupFactory.getLayoutFromEnum(
      PipelineBindGroupLayouts.OBJECT_UNIFORMS,
    );

    // Bind group para la matriz de modelo
    this.modelBindGroup = BindGroupFactory.createBindGroup(
      `transform_modelBindGroup`,
      modelBindGroupLayout,
      [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
    );
  }

  public load(data: TransformComponentDataType): void {
    if (data.position) {
      this.transform.setLocalPosition(data.position);
    }
    if (data.rotation) {
      this.transform.setAngles(data.rotation[1], data.rotation[0], data.rotation[2]);
    } else if (data.quaternion) {
      this.transform.setLocalRotation(data.quaternion);
    }

    if (data.scale) {
      const scale = vec3.fromValues(data.scale[0] ?? 1, data.scale[1] ?? 1, data.scale[2] ?? 1);
      this.transform.setLocalScale(scale);
    }
    if (data.matrix) {
      this.transform.fromMatrix(data.matrix);
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
    GPUUtils.writeBuffer(this.uniformBuffer, 0, new Float32Array(this.transform.getWorldMatrix()));
    // Si la entidad es instanciada, actualizar el buffer de instancias
    const entity = this.getOwner();
    const renderComp = entity.getComponent('render') as RenderComponent;
    if (renderComp && renderComp.getIsInstanced()) {
      InstanceManager.updateInstanceTransform(entity);
    }
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

  public update(): void {
    this.updateWorldTransform();
    this.updateModelMatrix();
    this.updateChildrenTransforms();
  }

  public override renderInMenu(): void {}

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
