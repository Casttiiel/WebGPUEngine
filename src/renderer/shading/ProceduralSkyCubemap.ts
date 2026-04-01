import { Engine } from '../../core/engine/Engine';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { MipmapGenerator } from '../core/processing/MipmapGenerator';
import { SamplerLibrary } from '../core/utils/SamplerLibrary';
import { Wind } from '../../core/engine/Wind';
import { mat4 } from 'gl-matrix';

// 128×128 cubemap — enough resolution for colour-accurate fog blending.
const FACE_SIZE = 128;
const MIP_COUNT = 8; // 128 → 1

// Standard cubemap face orientations (WebGPU / D3D convention)
const FACE_TARGETS: Array<[[number, number, number], [number, number, number]]> = [
  [
    [1, 0, 0],
    [0, -1, 0],
  ], // +X
  [
    [-1, 0, 0],
    [0, -1, 0],
  ], // -X
  [
    [0, 1, 0],
    [0, 0, 1],
  ], // +Y  (up = +Z)
  [
    [0, -1, 0],
    [0, 0, -1],
  ], // -Y  (up = -Z)
  [
    [0, 0, 1],
    [0, -1, 0],
  ], // +Z
  [
    [0, 0, -1],
    [0, -1, 0],
  ], // -Z
];

// CameraUniforms struct size (matches common/uniforms.wgsl):
//   5 × mat4x4<f32> = 320 B
//   cameraPosition: vec4<f32>  =  16 B
//   screenSize: vec2<f32>      =   8 B
//   time: f32                  =   4 B
//   timeDelta: f32             =   4 B
//   cameraFront: vec3<f32>     =  12 B
//   cameraFar: f32             =   4 B
//   -----------------------------------
//   Total                      = 368 B
const CAMERA_UNIFORM_BYTES = 368;

export class ProceduralSkyCubemap {
  private cubemapTexture!: GPUTexture;
  private faceRenderViews: GPUTextureView[] = [];
  private cubemapSampleView!: GPUTextureView;

  private skyTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;

  private faceCameraBuffers: GPUBuffer[] = [];
  private faceCameraBindGroups: GPUBindGroup[] = [];

  private proceduralUniformBuffer!: GPUBuffer;
  private proceduralBindGroup!: GPUBindGroup;

  private windOffset = 0.0;
  private lastRenderTime = 0;

  public async load(): Promise<void> {
    const device = GPUUtils.getDevice();

    // Use the depth-test-free variant of the sky scattering technique
    this.skyTechnique = await Technique.getAsync('lighting/skybox_scattering_cubemap.tech');
    this.fullscreenQuadMesh = await Mesh.getAsync('fullscreenquad.obj');

    // rgba16float cubemap: RENDER_ATTACHMENT for face rendering, TEXTURE_BINDING for fog
    // sampling, STORAGE_BINDING for compute-based mipmap generation.
    this.cubemapTexture = device.createTexture({
      label: 'procedural_sky_cubemap',
      size: [FACE_SIZE, FACE_SIZE, 6],
      format: 'rgba16float',
      mipLevelCount: MIP_COUNT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING,
    });

    // 2D render views for mip 0 of each face (render pass write targets)
    for (let face = 0; face < 6; face++) {
      this.faceRenderViews.push(
        this.cubemapTexture.createView({
          label: `sky_cubemap_face_${face}_render`,
          dimension: '2d',
          baseArrayLayer: face,
          arrayLayerCount: 1,
          baseMipLevel: 0,
          mipLevelCount: 1,
        }),
      );
    }

    // Cube view with all mip levels — used by the fog sampler
    this.cubemapSampleView = this.cubemapTexture.createView({
      label: 'sky_cubemap_sample',
      dimension: 'cube',
      mipLevelCount: MIP_COUNT,
    });

    // Procedural params uniform buffer (layout identical to Skybox: 48 bytes / 12 floats)
    this.proceduralUniformBuffer = GPUUtils.createBuffer(
      'sky_cubemap_procedural_uniforms',
      48,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Build per-face camera data first; then we can derive the group-1 layout
    this.buildFaceCameraData();

    // Procedural params bind group (group 1) — shared by all 6 face passes
    this.proceduralBindGroup = BindGroupFactory.createBindGroup(
      'sky_cubemap_procedural_bg',
      this.skyTechnique.getPipeline().getBindGroupLayout(1)!,
      [{ binding: 0, resource: { buffer: this.proceduralUniformBuffer } }],
    );

    // Initial render + mip generation so the cubemap is valid before the first
    // frame tries to sample it.
    this.updateProceduralUniforms();
    this.renderFaces();
    await MipmapGenerator.getInstance().generateMipmapsForCubemap(this.cubemapTexture, MIP_COUNT);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Builds the 90° look-at camera buffer for each of the 6 cube faces. */
  private buildFaceCameraData(): void {
    const device = GPUUtils.getDevice();
    const cameraLayout = this.skyTechnique.getPipeline().getBindGroupLayout(0)!;

    // 90° FOV, aspect 1:1.  get_view_dir only needs projMatrix[0][0] and [1][1],
    // both of which equal 1/tan(45°) = 1.0 for this configuration.
    const proj = mat4.create();
    mat4.perspective(proj, Math.PI / 2, 1.0, 0.1, 1000.0);

    for (let face = 0; face < 6; face++) {
      const [target, up] = FACE_TARGETS[face]!;
      const view = mat4.create();
      mat4.lookAt(view, [0, 0, 0], target, up);

      // Full CameraUniforms buffer, zeros except viewMatrix (offset 0) and
      // projectionMatrix (offset 64).  The sky shader only reads those two.
      const data = new Float32Array(CAMERA_UNIFORM_BYTES / 4);
      for (let i = 0; i < 16; i++) data[i] = view[i]!; // viewMatrix
      for (let i = 0; i < 16; i++) data[16 + i] = proj[i]!; // projectionMatrix

      const buf = GPUUtils.createBuffer(
        `sky_cubemap_camera_face_${face}`,
        CAMERA_UNIFORM_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      );
      device.queue.writeBuffer(buf, 0, data);
      this.faceCameraBuffers.push(buf);

      this.faceCameraBindGroups.push(
        BindGroupFactory.createBindGroup(`sky_cubemap_camera_bg_face_${face}`, cameraLayout, [
          { binding: 0, resource: { buffer: buf } },
        ]),
      );
    }
  }

  /** Writes current sky state to the procedural uniform buffer. */
  private updateProceduralUniforms(): void {
    const device = GPUUtils.getDevice();
    const envManager = Engine.getEnvironmentManager();

    const sunDir = envManager.getSunDirection();
    const timeOfDay = envManager.getTimeOfDay();

    const now = performance.now() * 0.001;
    if (this.lastRenderTime > 0) {
      this.windOffset += Wind.speed * (now - this.lastRenderTime);
    }
    this.lastRenderTime = now;

    const windRad = (Wind.dirAngle * Math.PI) / 180.0;

    // Layout mirrors SkyboxProceduralUniforms in skybox_scattering.fs
    const data = new Float32Array(12); // 48 bytes
    data[0] = sunDir[0];
    data[1] = sunDir[1];
    data[2] = sunDir[2];
    data[3] = timeOfDay;
    data[4] = Math.cos(windRad); // windDirection.x
    data[5] = Math.sin(windRad); // windDirection.y (z in world)
    data[6] = envManager.cloudThickness;
    data[7] = envManager.cloudDistanceFade;
    data[8] = this.windOffset;
    // [9..11] = padding (already zero)
    device.queue.writeBuffer(this.proceduralUniformBuffer, 0, data);
  }

  /**
   * Renders the 6 cubemap faces into mip level 0 using a dedicated command encoder
   * that is submitted immediately (before the main frame encoder).
   */
  private renderFaces(): void {
    const device = GPUUtils.getDevice();
    const encoder = device.createCommandEncoder({ label: 'sky_cubemap_render' });

    for (let face = 0; face < 6; face++) {
      const pass = encoder.beginRenderPass({
        label: `sky_cubemap_face_${face}`,
        colorAttachments: [
          {
            view: this.faceRenderViews[face]!,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });

      pass.setViewport(0, 0, FACE_SIZE, FACE_SIZE, 0, 1);
      pass.setScissorRect(0, 0, FACE_SIZE, FACE_SIZE);
      this.skyTechnique.activatePipeline(pass);
      this.fullscreenQuadMesh.activate(pass);
      pass.setBindGroup(0, this.faceCameraBindGroups[face]!);
      pass.setBindGroup(1, this.proceduralBindGroup);
      this.fullscreenQuadMesh.renderGroup(pass);
      pass.end();
    }

    device.queue.submit([encoder.finish()]);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Re-renders all 6 faces with the current sky state and kicks off mipmap
   * generation (fire-and-forget). The GPU queue guarantees submission order:
   *   1. Face render encoder  (submitted sync here)
   *   2. Main frame encoder   (submitted at Render.endFrame, later this tick)
   *   3. Mip-gen encoder      (submitted from the resolved async, next microtask)
   *
   * The fog pass is in the main frame encoder (step 2) while mips from the
   * PREVIOUS frame's step 3 are already on the GPU.  One-frame latency for the
   * mips is imperceptible for a slowly-animating sky.
   */
  public render(): void {
    this.updateProceduralUniforms();
    this.renderFaces();
    void MipmapGenerator.getInstance().generateMipmapsForCubemap(this.cubemapTexture, MIP_COUNT);
  }

  /** Cube GPUTextureView suitable for texture_cube<f32> sampling with all mip levels. */
  public getCubemapView(): GPUTextureView {
    return this.cubemapSampleView;
  }

  /** Linear mip-filtering sampler for the sky cubemap (clamp-to-edge on all axes). */
  public getSampler(): GPUSampler {
    return SamplerLibrary.environmentCubemap;
  }

  public dispose(): void {
    MipmapGenerator.getInstance().releaseCubemapMipCache(this.cubemapTexture);
    this.cubemapTexture?.destroy();
    this.faceCameraBuffers.forEach((b) => b.destroy());
    this.proceduralUniformBuffer?.destroy();
    this.faceRenderViews = [];
    this.faceCameraBindGroups = [];
    this.faceCameraBuffers = [];
  }
}
