import { vec3 } from 'gl-matrix';
import { Transform } from '../../core/math/Transform';
import { Component } from '../../core/ecs/Component';
import { TransformComponentDataType } from '../../types/TransformComponentData.type';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';
import { InstanceManager } from '../../renderer/core/managers/InstanceManager';
import { RenderComponent } from '../render/RenderComponent';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export class TransformComponent extends Component {
  private transform: Transform;
  private uniformBuffer!: GPUBuffer;
  private modelBindGroup!: GPUBindGroup;
  // CPU-side copy of the world matrix from the previous frame, used to fill
  // the previousModelMatrix slot in the GPU uniform buffer.
  private previousWorldMatrix: Float32Array = new Float32Array(16);
  // Reusable 128-byte staging array: [0..15]=current, [16..31]=previous (one GPU write)
  private readonly modelMatrixData: Float32Array = new Float32Array(32);
  private isFirstModelUpdate = true;
  // True if the world matrix changed between the previous frame and this one.
  // Read by VelocityBufferManager to skip static objects in the per-object velocity pass.
  private matrixChangedThisFrame: boolean = false;

  /** Proxy object bound to lil-gui sliders; kept in sync inside update(). */
  private _editorProxy: {
    posX: number;
    posY: number;
    posZ: number;
    rotX: number;
    rotY: number;
    rotZ: number;
    scaX: number;
    scaY: number;
    scaZ: number;
  } | null = null;

  constructor() {
    super();
    this.transform = new Transform();

    // Crear buffer uniforme para la model matrix + previous model matrix
    // Layout: modelMatrix (offset 0, 64 bytes) + previousModelMatrix (offset 64, 64 bytes)
    this.uniformBuffer = GPUUtils.createBuffer(
      'transform_uniformBuffer',
      16 * 4 * 2, // 2 matrices 4x4 (current + previous)
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
    // GPU uniform buffer layout (128 bytes):
    //   offset   0: currentModelMatrix  (floats 0-15)
    //   offset  64: previousModelMatrix (floats 16-31)
    //
    // On the very first call both slots are initialised to the same matrix so
    // newly-spawned objects produce zero velocity (no TAA ghost on spawn).
    const worldMatrix = new Float32Array(
      this.transform.getWorldMatrix() as unknown as ArrayLike<number>,
    );
    if (this.isFirstModelUpdate) {
      this.previousWorldMatrix.set(worldMatrix);
      this.isFirstModelUpdate = false;
    }
    this.modelMatrixData.set(worldMatrix, 0); // current  → floats 0-15
    this.modelMatrixData.set(this.previousWorldMatrix, 16); // previous → floats 16-31
    GPUUtils.writeBuffer(this.uniformBuffer, 0, this.modelMatrixData); // single write

    // Track whether the world matrix changed so the velocity pass can skip static objects.
    let changed = false;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(worldMatrix[i]! - this.previousWorldMatrix[i]!) > 1e-7) {
        changed = true;
        break;
      }
    }
    this.matrixChangedThisFrame = changed;

    this.previousWorldMatrix.set(worldMatrix); // save for next frame
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
        // Mark the child dirty so its updateWorldTransform knows parent world changed
        transformComponent.getTransform().markDirty();
        transformComponent.updateWorldTransform();
        transformComponent.updateModelMatrix();
        transformComponent.updateChildrenTransforms();
      }
    }
  }

  public update(): void {
    // Sync editor proxy every frame so lil-gui .listen() reflects live changes (gizmo drags, etc.)
    if (this._editorProxy) {
      const pos = this.transform.getLocalPosition();
      this._editorProxy.posX = pos[0]!;
      this._editorProxy.posY = pos[1]!;
      this._editorProxy.posZ = pos[2]!;
      const angles = this.transform.getAngles();
      this._editorProxy.rotX = angles.pitch * RAD2DEG;
      this._editorProxy.rotY = angles.yaw * RAD2DEG;
      this._editorProxy.rotZ = angles.roll * RAD2DEG;
      const scale = this.transform.getLocalScale();
      this._editorProxy.scaX = scale[0]!;
      this._editorProxy.scaY = scale[1]!;
      this._editorProxy.scaZ = scale[2]!;
    }

    // Only do work when something actually changed
    if (!this.transform.getIsDirty()) return;

    this.updateWorldTransform();
    this.updateModelMatrix();
    this.updateChildrenTransforms();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override renderInMenu(folder?: any): void {
    if (!folder) return;
    if (this._editorProxy) return; // already built

    // Initialise proxy from current transform values
    const pos = this.transform.getLocalPosition();
    const angles = this.transform.getAngles();
    const scale = this.transform.getLocalScale();
    this._editorProxy = {
      posX: pos[0]!,
      posY: pos[1]!,
      posZ: pos[2]!,
      rotX: angles.pitch * RAD2DEG,
      rotY: angles.yaw * RAD2DEG,
      rotZ: angles.roll * RAD2DEG,
      scaX: scale[0]!,
      scaY: scale[1]!,
      scaZ: scale[2]!,
    };
    const p = this._editorProxy;

    // Helper: add a numeric input + step-decrement + step-increment buttons
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addAxisControls = (
      parent: any,
      obj: any,
      key: string,
      label: string,
      stepRef: { v: number },
      onChange: () => void,
    ): void => {
      parent.add(obj, key).step(0.001).name(label).listen().onChange(onChange);
      parent
        .add(
          {
            fn: () => {
              obj[key] -= stepRef.v;
              onChange();
            },
          },
          'fn',
        )
        .name(`${label}  −`);
      parent
        .add(
          {
            fn: () => {
              obj[key] += stepRef.v;
              onChange();
            },
          },
          'fn',
        )
        .name(`${label}  +`);
    };

    const tFolder = folder.addFolder('Transform');
    tFolder.close();

    // ── Position ──────────────────────────────────────────────────────────────
    const posStep = { v: 0.1 };
    const applyPos = () => this.transform.setLocalPosition(vec3.fromValues(p.posX, p.posY, p.posZ));
    const posF = tFolder.addFolder('Position');
    posF.close();
    posF.add(posStep, 'v').step(0.001).name('± Step');
    addAxisControls(posF, p, 'posX', 'X', posStep, applyPos);
    addAxisControls(posF, p, 'posY', 'Y', posStep, applyPos);
    addAxisControls(posF, p, 'posZ', 'Z', posStep, applyPos);

    // ── Rotation (degrees) ───────────────────────────────────────────────────
    const rotStep = { v: 5.0 };
    const applyRot = () =>
      this.transform.setAngles(p.rotY * DEG2RAD, p.rotX * DEG2RAD, p.rotZ * DEG2RAD);
    const rotF = tFolder.addFolder('Rotation');
    rotF.close();
    rotF.add(rotStep, 'v').step(0.1).name('± Step °');
    addAxisControls(rotF, p, 'rotX', 'Pitch', rotStep, applyRot);
    addAxisControls(rotF, p, 'rotY', 'Yaw', rotStep, applyRot);
    addAxisControls(rotF, p, 'rotZ', 'Roll', rotStep, applyRot);

    // ── Scale ─────────────────────────────────────────────────────────────────
    const scaStep = { v: 0.1 };
    const applySca = () => this.transform.setLocalScale(vec3.fromValues(p.scaX, p.scaY, p.scaZ));
    const scaF = tFolder.addFolder('Scale');
    scaF.close();
    scaF.add(scaStep, 'v').step(0.001).name('± Step');
    addAxisControls(scaF, p, 'scaX', 'X', scaStep, applySca);
    addAxisControls(scaF, p, 'scaY', 'Y', scaStep, applySca);
    addAxisControls(scaF, p, 'scaZ', 'Z', scaStep, applySca);
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

  /** True if the world matrix changed between the previous frame and this frame.
   *  Used by the per-object velocity pass to skip static geometry. */
  public hasMovedThisFrame(): boolean {
    return this.matrixChangedThisFrame;
  }
}
