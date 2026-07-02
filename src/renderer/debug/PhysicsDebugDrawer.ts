import { Engine } from '../../core/engine/Engine';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { QualitySettings } from '../../core/engine/QualitySettings';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { Render } from '../core/pipeline/Render';
import { PipelineBindGroupLayouts } from '../../types/PipelineBindGroupLayouts.enum';

const MAX_VERTICES   = 65536;
const FLOATS_PER_VTX = 7; // xyz(3) + rgba(4)
const BYTES_PER_VTX  = FLOATS_PER_VTX * 4;
const CIRCLE_SEGS    = 16;

// Non-sensor collider color (green)
const COLOR_SOLID  : [number, number, number, number] = [0.0, 1.0, 0.2, 1.0];
// Sensor collider color (amber/yellow)
const COLOR_SENSOR : [number, number, number, number] = [1.0, 0.8, 0.0, 1.0];

export class PhysicsDebugDrawer {
  private static _instance: PhysicsDebugDrawer | null = null;

  public showColliders = false;
  public showSensors   = false;

  private pipeline          : GPURenderPipeline | null = null;
  private vertexBuf         : GPUBuffer | null = null;
  private depthTextureLayout: GPUBindGroupLayout | null = null;
  private cpuBuf            = new Float32Array(MAX_VERTICES * FLOATS_PER_VTX);
  private vCount            = 0;
  private ready             = false;

  private constructor() {}

  static getInstance(): PhysicsDebugDrawer {
    if (!this._instance) this._instance = new PhysicsDebugDrawer();
    return this._instance;
  }

  public isActive(): boolean { return this.showColliders || this.showSensors; }
  public toggleColliders(): void { this.showColliders = !this.showColliders; }
  public toggleSensors():   void { this.showSensors   = !this.showSensors;   }

  public async initialize(): Promise<void> {
    const device    = Render.getInstance().getDevice();
    const hdrFormat = QualitySettings.getInstance().getSettings().hdrTexture as GPUTextureFormat;

    this.vertexBuf = device.createBuffer({
      label : 'physics_debug_vb',
      size  : MAX_VERTICES * BYTES_PER_VTX,
      usage : GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    const vsCode = await ResourceManager.loadShader('debug/collider_wireframe.vs');
    const fsCode = await ResourceManager.loadShader('debug/collider_wireframe.fs');

    const vsModule = device.createShaderModule({ label: 'collider_wf_vs', code: vsCode });
    const fsModule = device.createShaderModule({ label: 'collider_wf_fs', code: fsCode });

    // Group 1: scene depth texture for software depth test in the fragment shader.
    // Post-processing shaders already read the same depth view as texture_depth_2d —
    // keeping it as a shader resource avoids re-transitioning it back to an attachment.
    this.depthTextureLayout = device.createBindGroupLayout({
      label: 'collider_wf_depth_layout',
      entries: [{
        binding    : 0,
        visibility : GPUShaderStage.FRAGMENT,
        texture    : { sampleType: 'depth', viewDimension: '2d' },
      }],
    });

    const cameraLayout = BindGroupFactory.getLayoutFromEnum(PipelineBindGroupLayouts.CAMERA_UNIFORMS);
    const pipelineLayout = device.createPipelineLayout({
      label: 'collider_wf_pipeline_layout',
      bindGroupLayouts: [cameraLayout, this.depthTextureLayout],
    });

    this.pipeline = await device.createRenderPipelineAsync({
      label   : 'collider_wireframe',
      layout  : pipelineLayout,
      vertex  : {
        module     : vsModule,
        entryPoint : 'vs',
        buffers    : [{
          arrayStride : BYTES_PER_VTX,
          attributes  : [
            { shaderLocation: 0, offset: 0,  format: 'float32x3' }, // position
            { shaderLocation: 1, offset: 12, format: 'float32x4' }, // color
          ],
        }],
      },
      fragment : {
        module     : fsModule,
        entryPoint : 'fs',
        targets    : [{ format: hdrFormat }],
      },
      primitive : { topology: 'line-list' },
      // No hardware depthStencil — depth occlusion is done in the fragment shader
      // by sampling sceneDepth (group 1) and discarding occluded fragments.
    });

    this.ready = true;
  }

  // ── CPU vertex helpers ──────────────────────────────────────────────────────

  private push(x: number, y: number, z: number, r: number, g: number, b: number, a: number): void {
    if (this.vCount >= MAX_VERTICES) return;
    const i = this.vCount++ * FLOATS_PER_VTX;
    this.cpuBuf[i]   = x; this.cpuBuf[i+1] = y; this.cpuBuf[i+2] = z;
    this.cpuBuf[i+3] = r; this.cpuBuf[i+4] = g; this.cpuBuf[i+5] = b; this.cpuBuf[i+6] = a;
  }

  private line(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    col: [number, number, number, number],
  ): void {
    this.push(ax, ay, az, col[0], col[1], col[2], col[3]);
    this.push(bx, by, bz, col[0], col[1], col[2], col[3]);
  }

  // Rotate vector (lx, ly, lz) by unit quaternion (qx, qy, qz, qw) — Rodrigues formula.
  private static rotQ(
    lx: number, ly: number, lz: number,
    qx: number, qy: number, qz: number, qw: number,
  ): [number, number, number] {
    const tx = 2 * (qy * lz - qz * ly);
    const ty = 2 * (qz * lx - qx * lz);
    const tz = 2 * (qx * ly - qy * lx);
    return [
      lx + qw * tx + (qy * tz - qz * ty),
      ly + qw * ty + (qz * tx - qx * tz),
      lz + qw * tz + (qx * ty - qy * tx),
    ];
  }

  // ── Shape generators ────────────────────────────────────────────────────────

  private addBox(
    tx: number, ty: number, tz: number,
    hx: number, hy: number, hz: number,
    qx: number, qy: number, qz: number, qw: number,
    col: [number, number, number, number],
  ): void {
    const signs: [number, number, number][] = [
      [-1,-1,-1],[+1,-1,-1],[-1,+1,-1],[+1,+1,-1],
      [-1,-1,+1],[+1,-1,+1],[-1,+1,+1],[+1,+1,+1],
    ];
    const pts = signs.map(([sx, sy, sz]) => {
      const [rx, ry, rz] = PhysicsDebugDrawer.rotQ(sx*hx, sy*hy, sz*hz, qx, qy, qz, qw);
      return [rx + tx, ry + ty, rz + tz] as [number, number, number];
    });
    const edges: [number, number][] = [
      [0,1],[1,3],[3,2],[2,0], // bottom face
      [4,5],[5,7],[7,6],[6,4], // top face
      [0,4],[1,5],[2,6],[3,7], // pillars
    ];
    for (const [i, j] of edges) {
      const [ax, ay, az] = pts[i]!;
      const [bx, by, bz] = pts[j]!;
      this.line(ax, ay, az, bx, by, bz, col);
    }
  }

  // Draw a full circle centered at (cx,cy,cz) with given world-space basis vectors u and v.
  private addCircle(
    cx: number, cy: number, cz: number,
    radius: number,
    ux: number, uy: number, uz: number,
    vx: number, vy: number, vz: number,
    col: [number, number, number, number],
  ): void {
    let px = cx + ux * radius;
    let py = cy + uy * radius;
    let pz = cz + uz * radius;
    for (let i = 1; i <= CIRCLE_SEGS; i++) {
      const angle = (i / CIRCLE_SEGS) * Math.PI * 2;
      const c = Math.cos(angle), s = Math.sin(angle);
      const nx = cx + (ux * c + vx * s) * radius;
      const ny = cy + (uy * c + vy * s) * radius;
      const nz = cz + (uz * c + vz * s) * radius;
      this.line(px, py, pz, nx, ny, nz, col);
      px = nx; py = ny; pz = nz;
    }
  }

  // Draw a semicircle arc. `up` direction determines which half (flipped = negative half).
  private addArc(
    cx: number, cy: number, cz: number,
    radius: number,
    ax: number, ay: number, az: number, // equatorial axis (start direction)
    ux: number, uy: number, uz: number, // "up" axis (towards the pole)
    col: [number, number, number, number],
    flipped: boolean,
  ): void {
    const sign = flipped ? -1 : 1;
    let px = cx + ax * radius;
    let py = cy + ay * radius;
    let pz = cz + az * radius;
    const half = CIRCLE_SEGS / 2;
    for (let i = 1; i <= half; i++) {
      const angle = (i / half) * Math.PI;
      const c = Math.cos(angle), s = Math.sin(angle);
      const nx = cx + (ax * c + ux * s * sign) * radius;
      const ny = cy + (ay * c + uy * s * sign) * radius;
      const nz = cz + (az * c + uz * s * sign) * radius;
      this.line(px, py, pz, nx, ny, nz, col);
      px = nx; py = ny; pz = nz;
    }
  }

  private addSphere(
    tx: number, ty: number, tz: number,
    radius: number,
    col: [number, number, number, number],
  ): void {
    this.addCircle(tx, ty, tz, radius, 1,0,0, 0,0,1, col); // XZ
    this.addCircle(tx, ty, tz, radius, 1,0,0, 0,1,0, col); // XY
    this.addCircle(tx, ty, tz, radius, 0,1,0, 0,0,1, col); // YZ
  }

  private addCapsule(
    tx: number, ty: number, tz: number,
    halfHeight: number,
    radius: number,
    qx: number, qy: number, qz: number, qw: number,
    col: [number, number, number, number],
  ): void {
    // Capsule axis is local Y. Compute world-space local axes.
    const [lxx, lxy, lxz] = PhysicsDebugDrawer.rotQ(1, 0, 0, qx, qy, qz, qw);
    const [lyx, lyy, lyz] = PhysicsDebugDrawer.rotQ(0, 1, 0, qx, qy, qz, qw);
    const [lzx, lzy, lzz] = PhysicsDebugDrawer.rotQ(0, 0, 1, qx, qy, qz, qw);

    // Top/bottom cap centers
    const [topX, topY, topZ] = [tx + lyx * halfHeight, ty + lyy * halfHeight, tz + lyz * halfHeight];
    const [botX, botY, botZ] = [tx - lyx * halfHeight, ty - lyy * halfHeight, tz - lyz * halfHeight];

    // Cylinder body: 2 circles and 4 vertical lines
    this.addCircle(topX, topY, topZ, radius, lxx, lxy, lxz, lzx, lzy, lzz, col);
    this.addCircle(botX, botY, botZ, radius, lxx, lxy, lxz, lzx, lzy, lzz, col);

    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2;
      const c = Math.cos(angle), s = Math.sin(angle);
      const ox = (lxx * c + lzx * s) * radius;
      const oy = (lxy * c + lzy * s) * radius;
      const oz = (lxz * c + lzz * s) * radius;
      this.line(topX+ox, topY+oy, topZ+oz, botX+ox, botY+oy, botZ+oz, col);
    }

    // Hemispherical caps: 2 arcs each in local XY and ZY planes
    this.addArc(topX, topY, topZ, radius, lxx, lxy, lxz, lyx, lyy, lyz, col, false);
    this.addArc(topX, topY, topZ, radius, lzx, lzy, lzz, lyx, lyy, lyz, col, false);
    this.addArc(botX, botY, botZ, radius, lxx, lxy, lxz, lyx, lyy, lyz, col, true);
    this.addArc(botX, botY, botZ, radius, lzx, lzy, lzz, lyx, lyy, lyz, col, true);
  }

  // ── Main draw call (injected into ModuleRender.generateFrame) ───────────────

  public draw(
    encoder      : GPUCommandEncoder,
    colorTarget  : GPUTextureView,
    depthView    : GPUTextureView,
    cameraGroup  : GPUBindGroup,
  ): void {
    if (!this.ready || !this.pipeline || !this.vertexBuf || !this.isActive()) return;

    this.vCount = 0;

    Engine.getPhysics().getWorld().forEachCollider((col) => {
      const sensor = col.isSensor();
      if (sensor  && !this.showSensors)   return;
      if (!sensor && !this.showColliders) return;

      const col_ = col as any;
      const color = sensor ? COLOR_SENSOR : COLOR_SOLID;
      const t  = col.translation();
      const q  = col.rotation();
      const sh = col_.shape as any;

      if (sh?.halfExtents) {
        const he = sh.halfExtents;
        this.addBox(t.x, t.y, t.z, he.x, he.y, he.z, q.x, q.y, q.z, q.w, color);
      } else if (sh?.halfHeight !== undefined && sh?.radius !== undefined) {
        this.addCapsule(t.x, t.y, t.z, sh.halfHeight, sh.radius, q.x, q.y, q.z, q.w, color);
      } else if (sh?.radius !== undefined) {
        this.addSphere(t.x, t.y, t.z, sh.radius, color);
      }
      // Trimesh: skip (too many triangles to outline usefully)
    });

    if (this.vCount === 0) return;

    const device = Render.getInstance().getDevice();

    device.queue.writeBuffer(
      this.vertexBuf, 0,
      this.cpuBuf.buffer, 0,
      this.vCount * BYTES_PER_VTX,
    );

    // Bind the scene depth as a shader resource (group 1) so the fragment shader
    // can do a software depth test.  We keep it as TEXTURE_BINDING (same state the
    // post-processing passes use) instead of re-transitioning it to a render
    // attachment, which some drivers handle inconsistently.
    const depthGroup = device.createBindGroup({
      label   : 'collider_wf_depth_bg',
      layout  : this.depthTextureLayout!,
      entries : [{ binding: 0, resource: depthView }],
    });

    const pass = encoder.beginRenderPass({
      label            : 'physics_debug',
      colorAttachments : [{
        view    : colorTarget,
        loadOp  : 'load',
        storeOp : 'store',
      }],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, cameraGroup);
    pass.setBindGroup(1, depthGroup);
    pass.setVertexBuffer(0, this.vertexBuf);
    pass.draw(this.vCount);
    pass.end();
  }
}
