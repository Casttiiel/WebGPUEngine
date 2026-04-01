import { Component } from '../../core/ecs/Component';
import { Engine } from '../../core/engine/Engine';
import { Render } from '../../renderer/core/pipeline/Render';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';
import { AreaLightComponentData } from '../../types/AreaLightComponentData.type';
import { TransformComponent } from '../core/TransformComponent';
import { GPUProfiler } from '../../core/debug/GPUProfiler';
import { mat4 } from 'gl-matrix';

/** 80 bytes = 5 × vec4 */
const UNIFORM_SIZE = 80;

export class AreaLightComponent extends Component {
  private fullscreenQuadMesh!: Mesh;
  private technique!: Technique;
  private lightBindGroup!: GPUBindGroup;
  private uniformBuffer!: GPUBuffer;

  // Cached CPU-side uniform data (reused every frame — zero allocation)
  private readonly uniformData = new Float32Array(UNIFORM_SIZE / 4);

  private color: [number, number, number] = [1, 1, 1];
  private intensity = 1.0;
  private halfWidth = 0.5;
  private halfHeight = 0.5;
  private radius = 10.0;
  private startFalloff = 5.0;
  private twoSided = false;

  private _isVisible = true;

  constructor() {
    super();
  }

  public async load(data: AreaLightComponentData): Promise<void> {
    this.color = data.color ?? [1, 1, 1];
    this.intensity = data.intensity ?? 1.0;
    this.halfWidth = (data.width ?? 1.0) * 0.5;
    this.halfHeight = (data.height ?? 1.0) * 0.5;
    this.radius = data.radius ?? 10.0;
    this.startFalloff = data.startFalloff ?? this.radius * 0.5;
    this.twoSided = data.twoSided ?? false;

    [this.fullscreenQuadMesh, this.technique] = await Promise.all([
      Mesh.getAsync('fullscreenquad.obj'),
      Technique.getAsync('lighting/area_light.tech'),
    ]);

    this.uniformBuffer = GPUUtils.createBuffer(
      'area_light_uniform_buffer',
      UNIFORM_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const layout = BindGroupFactory.getLayoutFromEnum(PipelineBindGroupLayouts.AREA_LIGHT_UNIFORMS);
    this.lightBindGroup = BindGroupFactory.createBindGroup('area_light_bindgroup', layout, [
      { binding: 0, resource: { buffer: this.uniformBuffer } },
    ]);
  }

  public override update(_dt: number): void {
    this.updateUniforms();
  }

  // ─── Uniform update ─────────────────────────────────────────────────────────
  private updateUniforms(): void {
    const entity = this.getOwner();
    if (!entity) return;

    const transformComp = entity.getComponent('transform') as TransformComponent | undefined;
    if (!transformComp) return;

    const transform = transformComp.getTransform();
    const worldPos = transform.getWorldPosition();
    const worldMat: mat4 = transform.getWorldMatrix();

    // gl-matrix stores matrices column-major:
    //   right  = col 0 = indices [0,1,2]
    //   up     = col 1 = indices [4,5,6]
    const d = this.uniformData;

    // colorIntensity  (offset 0)
    d[0] = this.color[0];
    d[1] = this.color[1];
    d[2] = this.color[2];
    d[3] = this.intensity;

    // position  (offset 16)
    d[4] = worldPos[0];
    d[5] = worldPos[1];
    d[6] = worldPos[2];
    d[7] = 0;

    // right axis + halfWidth  (offset 32)
    const rx = worldMat[0],
      ry = worldMat[1],
      rz = worldMat[2];
    const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    d[8] = rx / rLen;
    d[9] = ry / rLen;
    d[10] = rz / rLen;
    d[11] = this.halfWidth;

    // up axis + halfHeight  (offset 48)
    const ux = worldMat[4],
      uy = worldMat[5],
      uz = worldMat[6];
    const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    d[12] = ux / uLen;
    d[13] = uy / uLen;
    d[14] = uz / uLen;
    d[15] = this.halfHeight;

    // params  (offset 64)
    d[16] = this.radius;
    d[17] = this.twoSided ? 1.0 : 0.0;
    d[18] = this.startFalloff;
    d[19] = 0;

    Render.getInstance().getDevice().queue.writeBuffer(this.uniformBuffer, 0, d);
  }

  // ─── Render ──────────────────────────────────────────────────────────────────
  public render(rtAccLight: GPUTextureView, gBufferWithAOBindGroup: GPUBindGroup): void {
    const render = Render.getInstance();

    const colorAttachment = GPUUtils.createColorAttachment(rtAccLight, 'load', 'store');
    const passDesc = GPUUtils.createRenderPassDescriptor('area_light_render_pass', [
      colorAttachment,
    ]);

    const ts = GPUProfiler.getInstance().getTimestampWrites('Area Light');
    if (ts) passDesc.timestampWrites = ts;

    const pass = render.getCommandEncoder().beginRenderPass(passDesc);
    GPUUtils.configureViewportAndScissor(pass);

    this.technique.activatePipeline(pass);
    this.fullscreenQuadMesh.activate(pass);

    pass.setBindGroup(0, Engine.getRender().getMainCameraBindGroup());
    pass.setBindGroup(1, gBufferWithAOBindGroup);
    pass.setBindGroup(2, this.lightBindGroup);

    this.fullscreenQuadMesh.renderGroup(pass);
    pass.end();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────
  public isVisible(): boolean {
    return this._isVisible;
  }

  public setIsVisible(visible: boolean): void {
    this._isVisible = visible;
  }

  public setColor(r: number, g: number, b: number): void {
    this.color = [r, g, b];
  }

  public setIntensity(value: number): void {
    this.intensity = value;
  }

  public setSize(width: number, height: number): void {
    this.halfWidth = width * 0.5;
    this.halfHeight = height * 0.5;
  }

  public setRadius(radius: number, startFalloff?: number): void {
    this.radius = radius;
    this.startFalloff = startFalloff ?? radius * 0.5;
  }

  public setTwoSided(value: boolean): void {
    this.twoSided = value;
  }

  public override dispose(): void {
    this.uniformBuffer?.destroy();
  }

  public renderDebug(): void {}
}
