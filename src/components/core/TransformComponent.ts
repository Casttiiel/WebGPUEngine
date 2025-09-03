import { mat4, vec3 } from 'gl-matrix';
import { Transform } from '../../core/math/Transform';
import { Component } from '../../core/ecs/Component';
import { TransformComponentDataType } from '../../types/TransformComponentData.type';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';
import { Engine } from '../../core/engine/Engine';

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

  public override renderInMenu(): void {
    if (!this.transform) return;

    // Get the owner entity
    const entity = this.getOwner();
    const entityId = entity.id;
    const entityKey = `entity_${entityId}`;

    // Get the parent folder from the entity hierarchy
    let parentFolder = 'entities';
    const parentEntity = entity.getParent();
    if (parentEntity) {
      const parentId = parentEntity.id;
      const parentEntityKey = `entity_${parentId}`;
      // If this entity has a parent, it's in a subfolder
      parentFolder = `entities_${parentEntityKey}`;
    }

    // Create helper methods to access DebugUIManager
    const addControl = (
      object: unknown,
      propertyKey: string,
      label: string,
      options?: { min?: number; max?: number; step?: number },
    ) => {
      const debugUI = Engine.getDebugUI();
      // Especificar explícitamente readonly: false para que los controles sean interactivos
      debugUI.addControlToSubFolder(parentFolder, entityKey, object, propertyKey, label, {
        ...(options || {}),
        readonly: false,
      });
    };

    // Create reactive objects for position, rotation, and scale that update the transform
    const position = {
      get x() {
        return this.transform.getLocalPosition()[0];
      },
      set x(value) {
        const pos = this.transform.getLocalPosition();
        pos[0] = value;
        this.transform.setLocalPosition(pos);
        this.update();
      },
      get y() {
        return this.transform.getLocalPosition()[1];
      },
      set y(value) {
        const pos = this.transform.getLocalPosition();
        pos[1] = value;
        this.transform.setLocalPosition(pos);
        this.update();
      },
      get z() {
        return this.transform.getLocalPosition()[2];
      },
      set z(value) {
        const pos = this.transform.getLocalPosition();
        pos[2] = value;
        this.transform.setLocalPosition(pos);
        this.update();
      },
      transform: this.transform,
      update: () => {
        this.update();
      },
    };

    const scale = {
      get x() {
        return this.transform.getLocalScale()[0];
      },
      set x(value) {
        const scl = this.transform.getLocalScale();
        scl[0] = value;
        this.transform.setLocalScale(scl);
        this.update();
      },
      get y() {
        return this.transform.getLocalScale()[1];
      },
      set y(value) {
        const scl = this.transform.getLocalScale();
        scl[1] = value;
        this.transform.setLocalScale(scl);
        this.update();
      },
      get z() {
        return this.transform.getLocalScale()[2];
      },
      set z(value) {
        const scl = this.transform.getLocalScale();
        scl[2] = value;
        this.transform.setLocalScale(scl);
        this.update();
      },
      transform: this.transform,
      update: () => {
        this.update();
      },
    };

    // For rotation, we'll use Euler angles (in degrees for better UI)
    const angles = this.transform.getAngles();
    const euler = {
      _x: angles.pitch * (180 / Math.PI), // Convert to degrees
      _y: angles.yaw * (180 / Math.PI),
      _z: angles.roll * (180 / Math.PI),
      get x() {
        return this._x;
      },
      set x(value) {
        this._x = value;
        this.updateRotation();
      },
      get y() {
        return this._y;
      },
      set y(value) {
        this._y = value;
        this.updateRotation();
      },
      get z() {
        return this._z;
      },
      set z(value) {
        this._z = value;
        this.updateRotation();
      },
      transform: this.transform,
      updateRotation() {
        // Update rotation using the transform helper method
        this.transform.setAngles(this._y, this._x, this._z);
        this.update();
      },
      update: () => {
        this.update();
      },
    };

    // Add controls for position
    addControl(position, 'x', 'Position X', { min: -10, max: 10, step: 0.1 });
    addControl(position, 'y', 'Position Y', { min: -10, max: 10, step: 0.1 });
    addControl(position, 'z', 'Position Z', { min: -10, max: 10, step: 0.1 });

    // Add controls for rotation (in degrees for better UX)
    addControl(euler, 'x', 'Rotation X°', { min: -180, max: 180, step: 1 });
    addControl(euler, 'y', 'Rotation Y°', { min: -180, max: 180, step: 1 });
    addControl(euler, 'z', 'Rotation Z°', { min: -180, max: 180, step: 1 });

    // Add controls for scale
    addControl(scale, 'x', 'Scale X', { min: 0.01, max: 10, step: 0.01 });
    addControl(scale, 'y', 'Scale Y', { min: 0.01, max: 10, step: 0.01 });
    addControl(scale, 'z', 'Scale Z', { min: 0.01, max: 10, step: 0.01 });
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
