import { vec3, vec4 } from 'gl-matrix';
import { Component } from '../../core/ecs/Component';
import { Technique } from '../../renderer/resources/Technique';
import { TransformComponent } from '../core/TransformComponent';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { PointLightComponentData } from '../../types/PointLightComponentData.type';
import { SamplerLibrary } from '../../renderer/core/utils/SamplerLibrary';
import { Texture } from '../../renderer/resources/Texture';
import { AABB } from '../../core/math/AABB';

export class PointLightComponent extends Component {
  private color = vec4.create();
  private position = vec3.create();
  private intensity = 1.0;
  private radius = 1.0;
  private startFallof = 0.0;
  private isDirty = true;
  private _isVisible = false;
  private projectorTexture!: Texture;
  private projectorTextureView!: GPUTextureView;

  private uniformBindGroup!: GPUBindGroup;
  private uniformBuffer!: GPUBuffer;

  private dummyShadowTexture!: GPUTexture;
  private technique!: Technique;

  // ✅ Reusable buffers for GPU writes (zero allocations in update)
  private colorBuffer = new Float32Array(4);
  private positionBuffer = new Float32Array(4);
  private radiusBuffer = new Float32Array(4);
  private falloffBuffer = new Float32Array(4);

  private aabb: AABB = new AABB();

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

    if (data.startFallof) {
      this.startFallof = data.startFallof;
    }

    this.technique = await Technique.getAsync('point_light.tech');
    this.uniformBuffer = GPUUtils.createBuffer(
      'point light uniform buffer',
      36 * 4,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    this.projectorTexture = await Texture.getAsync('white.png');
    this.projectorTextureView = this.projectorTexture.getTextureView()!;

    // Create dummy shadow resources for the DIRECTIONAL_LIGHT_UNIFORMS layout
    this.dummyShadowTexture = GPUUtils.createTexture(
      'dummy_shadow_texture_point_light',
      1,
      1,
      'depth32float',
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    );
    const dummyShadowSampler = SamplerLibrary.shadows;

    this.uniformBindGroup = BindGroupFactory.createBindGroup(
      `point light uniform bind group`,
      this.technique.getPipeline().getBindGroupLayout(3)!,
      [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
        {
          binding: 1,
          resource: this.dummyShadowTexture.createView(),
        },
        {
          binding: 2,
          resource: dummyShadowSampler,
        },
        {
          binding: 3,
          resource: this.projectorTextureView!,
        },
        {
          binding: 4,
          resource: SamplerLibrary.simpleSampler,
        },
      ],
    );

    this.calculateWorldAABB();
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
        .setLocalScale(vec3.fromValues(this.radius * 2.0, this.radius * 2.0, this.radius * 2.0));
      vec3.copy(this.position, transform.getTransform().getWorldPosition());

      // ✅ Update reusable buffers instead of creating new Float32Arrays
      this.colorBuffer[0] = this.color[0];
      this.colorBuffer[1] = this.color[1];
      this.colorBuffer[2] = this.color[2];
      this.colorBuffer[3] = this.color[3];

      this.positionBuffer[0] = this.position[0];
      this.positionBuffer[1] = this.position[1];
      this.positionBuffer[2] = this.position[2];
      this.positionBuffer[3] = this.intensity;

      this.radiusBuffer[0] = this.radius;
      this.radiusBuffer[1] = 0.0;
      this.radiusBuffer[2] = 0.0;
      this.radiusBuffer[3] = 0.0;

      this.falloffBuffer[0] = this.startFallof;
      this.falloffBuffer[1] = 0.0;
      this.falloffBuffer[2] = 0.0;
      this.falloffBuffer[3] = 0.0;

      GPUUtils.writeBuffer(this.uniformBuffer, 0, this.colorBuffer);
      GPUUtils.writeBuffer(this.uniformBuffer, 16, this.positionBuffer);
      GPUUtils.writeBuffer(this.uniformBuffer, 96, this.radiusBuffer);
      GPUUtils.writeBuffer(this.uniformBuffer, 112, this.falloffBuffer);

      this.calculateWorldAABB();

      this.isDirty = false;
    }
  }

  private calculateWorldAABB(): void {
    const r = this.radius;
    const pos = this.position;
    const min = vec3.fromValues(pos[0] - r, pos[1] - r, pos[2] - r);
    const max = vec3.fromValues(pos[0] + r, pos[1] + r, pos[2] + r);
    this.aabb.min = min;
    this.aabb.max = max;
  }

  public debugInMenu(): void {
    // Implement debug menu if needed
  }

  public renderDebug(): void {
    // Implement debug rendering if needed
  }

  public getUniformBuffer(): GPUBuffer {
    return this.uniformBuffer;
  }

  public getShadowDepthView(): GPUTextureView {
    return this.dummyShadowTexture.createView(); // Point lights do not have shadow maps in this implementation
  }

  public getShadowSampler(): GPUSampler {
    return SamplerLibrary.shadows;
  }

  public isVisible(): boolean {
    return this._isVisible;
  }

  public setIsVisible(visible: boolean): void {
    this._isVisible = visible;
  }

  public getAABB(): AABB {
    return this.aabb;
  }
}
