import { vec3, vec4, mat4 } from 'gl-matrix';
import { Render } from '../../renderer/core/Render';
import { Technique } from '../../renderer/resources/Technique';
import { CameraComponent } from './CameraComponent';

/*float4 LightColor;
  float3 LightPosition;
  float  LightIntensity;
  matrix LightViewProjOffset;
  float  LightShadowStep;
  float  LightShadowInverseResolution;
  float  LightShadowStepDivResolution;
  float  LightRadius;
*/

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

    const position = data.position || [0, 0, 0];
    const target = data.target || [0, 0, 1];
    const up = data.up || [0, 1, 0];
    this.camera.lookAt(position, target, up);

    this.technique = await Technique.get('spot_light.tech');

    this.uniformBuffer = Render.getInstance()
      .getDevice()
      .createBuffer({
        label: `spot light uniform buffer`,
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

    this.uniformBindGroup = Render.getInstance()
      .getDevice()
      .createBindGroup({
        label: `spot light uniform bind group`,
        layout: this.technique.getPipeline().getBindGroupLayout(3),
        entries: [
          {
            binding: 0,
            resource: { buffer: this.uniformBuffer },
          },
        ],
      });

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

    const modelBindGroupLayout = render.getDevice().createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const device = render.getDevice();

    this.modelUniformBuffer = device.createBuffer({
      label: `spot_light_transform_uniformBuffer`,
      size: 16 * 4, // 1 matriz 4x4 (model)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const res = mat4.create();
    mat4.invert(res, this.camera.getViewProjection());
    device.queue.writeBuffer(this.modelUniformBuffer, 0, new Float32Array(res));

    // Bind group para la matriz de modelo
    this.modelBindGroup = device.createBindGroup({
      label: `transform_modelBindGroup`,
      layout: modelBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.modelUniformBuffer },
        },
      ],
    });
  }

  public setBindGroup(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(2, this.modelBindGroup); //for model matrix
    pass.setBindGroup(3, this.uniformBindGroup); // spot light parameters
  }

  public override update(dt: number): void {}

  public debugInMenu(): void {
    // Implement debug menu if needed
  }

  public override renderDebug(): void {
    // Implement debug rendering if needed
  }
}
