import { mat4, vec3 } from 'gl-matrix';
import { Render } from '../../renderer/core/pipeline/Render';
import { BindGroupFactory } from '../../renderer/core/factories/BindGroupFactory';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { RenderKey } from '../../renderer/core/managers/RenderKeyManager';

export class Camera {
  private view: mat4 = mat4.create();
  private projection: mat4 = mat4.create();
  private unjitteredProjection: mat4 = mat4.create(); // projection without jitter — stored before jitter is added
  private viewProjection: mat4 = mat4.create();
  private unjitteredViewProjection: mat4 = mat4.create(); // VP without jitter — for velocity buffer
  private unjitteredInvViewProjection: mat4 = mat4.create(); // inv(unjitteredVP) — for velocity buffer world reconstruction
  private invViewProjection: mat4 = mat4.create();
  private invProjection: mat4 = mat4.create();
  private invView: mat4 = mat4.create();

  private eye: vec3 = vec3.fromValues(0, 0, 0);
  private target: vec3 = vec3.fromValues(0, 0, -1);
  private upAux: vec3 = vec3.fromValues(0, 1, 0);

  private front: vec3 = vec3.fromValues(0, 0, -1);
  private left: vec3 = vec3.fromValues(-1, 0, 0);
  private up: vec3 = vec3.fromValues(0, 1, 0);

  private zNear: number = 0.1;
  private zFar: number = 1000.0;
  private fovRadians: number = (60 * Math.PI) / 180; // 60 degrees in radians
  private isOrtho: boolean = false;

  // Ortho parameters
  private orthoLeft: number = 0;
  private orthoTop: number = 0;
  private orthoWidth: number = 1.0;
  private orthoHeight: number = 1.0;
  private orthoCentered: boolean = false;

  private useReverseZ: boolean = true;
  private isDirty: boolean = true;
  private culledKeys: RenderKey[] = [];

  // Jittering for temporal anti-aliasing (SMAA T2x, TAA, etc.)
  private jitterEnabled: boolean = false;
  private jitterIndex: number = 0;
  private jitterOffsetX: number = 0;
  private jitterOffsetY: number = 0;
  private prevJitterOffsetX: number = 0;
  private prevJitterOffsetY: number = 0;

  private uniformData = new Float32Array(128); // 512 bytes / 4 = 128 floats

  // Time tracking for shader animations
  private time: number = 0;
  private deltaTime: number = 0;
  private frameIndex: number = 0;
  private readonly TIME_RESET_INTERVAL = 3600.0; // Reset every hour to avoid float precision loss

  // Jitter patterns
  // Halton(2,3) 16-point sequence — indexed from 1, centred around 0.5.
  // 16 points instead of 8: the longer period reduces perceptible periodic patterns
  // at sub-pixel features (1-pixel cracks, thin geometry edges) where a short 8-frame
  // cycle causes visible temporal shimmer at each full repetition.
  private static readonly HALTON_8: [number, number][] = [
    // base-2,         base-3           index
    [0.5, 1.0 / 3.0], // 1
    [0.25, 2.0 / 3.0], // 2
    [0.75, 1.0 / 9.0], // 3
    [0.125, 4.0 / 9.0], // 4
    [0.625, 7.0 / 9.0], // 5
    [0.375, 2.0 / 9.0], // 6
    [0.875, 5.0 / 9.0], // 7
    [0.0625, 8.0 / 9.0], // 8
    [0.5625, 1.0 / 27.0], // 9
    [0.3125, 10.0 / 27.0], // 10
    [0.8125, 19.0 / 27.0], // 11
    [0.1875, 4.0 / 27.0], // 12
    [0.6875, 13.0 / 27.0], // 13
    [0.4375, 22.0 / 27.0], // 14
    [0.9375, 7.0 / 27.0], // 15
    [0.03125, 16.0 / 27.0], // 16
  ];

  // Viewport
  private viewport = {
    x0: 0,
    y0: 0,
    width: Render.width,
    height: Render.height,
  };
  private aspectRatio: number = Math.abs(this.viewport.width / this.viewport.height);

  private uniformBuffer!: GPUBuffer;
  private bindGroup!: GPUBindGroup;

  constructor() {
    this.initializeUniformBuffers();
  }

  private updateViewProjection(): void {
    mat4.multiply(this.viewProjection, this.projection, this.view);
    // Always keep unjittered VP in sync — lookAt() only updates this.view, so
    // recomputing here ensures rotation + translation changes are always reflected.
    mat4.multiply(this.unjitteredViewProjection, this.unjitteredProjection, this.view);
    mat4.invert(this.unjitteredInvViewProjection, this.unjitteredViewProjection);
    this.calculateInvViewMatrix();
    this.calculateInvViewProjectionMatrix();
  }

  private calculateInvViewMatrix(): void {
    const invView = mat4.create();
    mat4.invert(invView, this.view);

    // Store the inverse view-projection matrix as invViewProjection
    this.invView = invView;
  }

  private calculateInvViewProjectionMatrix(): void {
    // Create inverse view-projection matrix for world position reconstruction
    // This matrix transforms from NDC space (-1 to 1) to world space
    const invViewProjection = mat4.create();
    mat4.invert(invViewProjection, this.viewProjection);

    // Store the inverse view-projection matrix as invViewProjection
    this.invViewProjection = invViewProjection;
  }

  private updateProjection(): void {
    if (this.isOrtho) {
      if (this.orthoCentered) {
        mat4.orthoZO(
          this.projection,
          -this.orthoWidth / 2,
          this.orthoWidth / 2,
          -this.orthoHeight / 2,
          this.orthoHeight / 2,
          this.zNear,
          this.zFar,
        );
      } else {
        mat4.orthoZO(
          this.projection,
          this.orthoLeft,
          this.orthoLeft + this.orthoWidth,
          this.orthoTop - this.orthoHeight,
          this.orthoTop,
          this.zNear,
          this.zFar,
        );
      }
      // Ortho cameras never use jitter — unjitteredProjection == projection.
      mat4.copy(this.unjitteredProjection, this.projection);
    } else {
      if (this.useReverseZ) {
        mat4.perspectiveZO(this.projection, this.fovRadians, this.aspectRatio, this.zFar, this.zNear);
      } else {
        mat4.perspectiveZO(this.projection, this.fovRadians, this.aspectRatio, this.zNear, this.zFar);
      }

      // Snapshot the clean (unjittered) projection — updateViewProjection() will use
      // this to keep unjitteredViewProjection always current regardless of view changes.
      mat4.copy(this.unjitteredProjection, this.projection);

      // Apply jittering to projection matrix if enabled
      if (this.jitterEnabled) {
        // Modify projection matrix to offset the projection center
        // projection[8] and projection[9] are the (2,0) and (2,1) elements
        this.projection[8] += this.jitterOffsetX;
        this.projection[9] += this.jitterOffsetY;
      }
    }
    this.calculateInvProjectionMatrix();
    this.updateViewProjection();
  }

  private calculateInvProjectionMatrix(): void {
    const invProjection = mat4.create();
    mat4.invert(invProjection, this.projection);

    this.invProjection = invProjection;
  }

  public setUseReverseZ(value: boolean): void {
    this.useReverseZ = value;
    this.updateProjection();
  }

  public setProjectionParams(fov: number, zNear: number, zFar: number): void {
    this.isOrtho = false;
    this.fovRadians = fov;
    this.zNear = zNear;
    this.zFar = zFar;
    this.updateProjection();
    this.isDirty = true;
  }

  public setOrthoParams(
    centered: boolean = true,
    left: number = 0,
    width: number = 20,
    top: number = 0,
    height: number = 20,
  ): void {
    this.isOrtho = true;
    this.orthoCentered = centered;
    this.orthoLeft = left;
    this.orthoWidth = width;
    this.orthoTop = top;
    this.orthoHeight = height;

    // For orthographic cameras, aspect ratio should match the ortho dimensions
    this.aspectRatio = Math.abs(width / height);
    this.updateProjection();
    this.isDirty = true;
  }

  public lookAt(newEye: vec3, newTarget: vec3, newUpAux: vec3 = vec3.fromValues(0, 1, 0)): void {
    vec3.copy(this.eye, newEye);
    vec3.copy(this.target, newTarget);
    vec3.copy(this.upAux, newUpAux);

    mat4.lookAt(this.view, this.eye, this.target, this.upAux);

    // Regenerate 3 main axes
    vec3.sub(this.front, this.target, this.eye);
    vec3.normalize(this.front, this.front);

    vec3.cross(this.left, this.upAux, this.front);
    vec3.normalize(this.left, this.left);

    vec3.cross(this.up, this.front, this.left);

    this.updateViewProjection();
    this.isDirty = true;
  }

  public setViewport(width: number, height: number): void {
    this.viewport.width = width;
    this.viewport.height = height;

    this.aspectRatio = width / height;
    this.isDirty = true;

    if (!this.isOrtho) {
      this.updateProjection();
    }
  }

  public move(delta: number[]): void {
    vec3.add(this.eye, this.eye, delta as vec3);
    vec3.add(this.target, this.target, delta as vec3);
    this.lookAt(this.eye, this.target, this.upAux);
    this.isDirty = true;
  }

  public rotate(yaw: number, pitch: number): void {
    // Aplicar rotación yaw (alrededor del eje Y)
    const rotMat = mat4.create();
    mat4.rotate(rotMat, rotMat, yaw, this.upAux);
    vec3.transformMat4(this.front, this.front, rotMat);

    // Aplicar rotación pitch (alrededor del eje local X)
    const right = vec3.cross(vec3.create(), this.front, this.upAux);
    vec3.normalize(right, right);
    mat4.rotate(rotMat, mat4.create(), pitch, right);
    vec3.transformMat4(this.front, this.front, rotMat);
    vec3.normalize(this.front, this.front);

    // Calcular nueva posición del target
    vec3.add(this.target, this.eye, this.front);

    // Actualizar la cámara
    this.lookAt(this.eye, this.target, this.upAux);
    this.isDirty = true;
  }

  public getLocalVector(vec: number[]): vec3 {
    const result = vec3.create();
    vec3.scale(result, this.left, vec[0] || 0);
    vec3.scaleAndAdd(result, result, this.up, vec[1] || 0);
    vec3.scaleAndAdd(result, result, this.front, vec[2] || 0);
    return result;
  }

  // ✅ Zero-allocation version: writes result to output parameter
  public getLocalVectorTo(vec: number[], out: vec3): void {
    vec3.scale(out, this.left, vec[0] || 0);
    vec3.scaleAndAdd(out, out, this.up, vec[1] || 0);
    vec3.scaleAndAdd(out, out, this.front, vec[2] || 0);
  }

  private initializeUniformBuffers(): void {
    // Crear buffer uniforme global para las matrices de la cámara
    this.uniformBuffer = GPUUtils.createBuffer(
      'camera uniform buffer',
      512,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Crear el bind group global usando la factory
    const bindGroupLayout = BindGroupFactory.getCameraUniformsLayout();
    this.bindGroup = BindGroupFactory.createBindGroup(
      'camera uniform bind group',
      bindGroupLayout,
      [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
    );
  }

  public setViewMatrix(viewMatrix: mat4): void {
    mat4.copy(this.view, viewMatrix);

    // Recalcular eye position desde la view matrix inversa
    // eye = -R^T * t
    const tx = viewMatrix[12];
    const ty = viewMatrix[13];
    const tz = viewMatrix[14];
    this.eye[0] = -(viewMatrix[0] * tx + viewMatrix[1] * ty + viewMatrix[2] * tz);
    this.eye[1] = -(viewMatrix[4] * tx + viewMatrix[5] * ty + viewMatrix[6] * tz);
    this.eye[2] = -(viewMatrix[8] * tx + viewMatrix[9] * ty + viewMatrix[10] * tz);

    this.updateViewProjection();
    this.isDirty = true;
  }

  public updateUniforms(deltaTime: number): void {
    // Update time tracking
    this.deltaTime = deltaTime;
    this.time += this.deltaTime;

    // Reset time every hour to prevent float precision loss
    if (this.time >= this.TIME_RESET_INTERVAL) {
      this.time = 0;
    }

    if (!this.isDirty) return;

    // Copy matrices and data into single buffer
    const viewMatrix = this.getView();
    const projectionMatrix = this.getProjection();
    const invViewProjectionMatrix = this.getInvViewProjectionMatrix();
    const invProjectionMatrix = this.getInvProjectionMatrix();
    const invViewMatrix = this.invView;
    const cameraPosition = this.getPosition();
    const cameraFront = this.getFront();

    // === ALL MATRICES FIRST (320 bytes total) ===
    // viewMatrix (offset 0-15 = 0-63 bytes)
    this.uniformData.set(viewMatrix, 0);

    // projectionMatrix (offset 16-31 = 64-127 bytes)
    this.uniformData.set(projectionMatrix, 16);

    // invViewProjectionMatrix (offset 32-47 = 128-191 bytes)
    this.uniformData.set(invViewProjectionMatrix, 32);

    // invProjectionMatrix (offset 48-63 = 192-255 bytes)
    this.uniformData.set(invProjectionMatrix, 48);

    // invViewMatrix (offset 64-79 = 256-319 bytes)
    this.uniformData.set(invViewMatrix, 64);

    // === SCALAR DATA AFTER MATRICES ===
    // cameraPosition (offset 80-83 = 320-335 bytes) vec4
    this.uniformData.set([cameraPosition[0], cameraPosition[1], cameraPosition[2], 0], 80);

    // screenSize (offset 84-85 = 336-343 bytes) vec2 + padding
    this.uniformData[84] = Render.width;
    this.uniformData[85] = Render.height;
    this.uniformData[86] = this.time;
    this.uniformData[87] = this.deltaTime;

    // cameraFront + cameraZFar (offset 88-91 = 352-367 bytes) vec4
    this.uniformData.set([cameraFront[0], cameraFront[1], cameraFront[2], this.getFar()], 88);

    // jitterOffset (offset 92-93 = 368-375 bytes) vec2  — UV-space sub-pixel offset
    // getJitterOffset() returns [(pattern[0]-0.5)/width, (pattern[1]-0.5)/height]
    // In the shader, multiply by screenSize to get pixel-space offsets.
    const [jx, jy] = this.getJitterOffset();
    this.uniformData[92] = jx;
    this.uniformData[93] = jy;
    // prevJitterOffset (offset 94-95 = 376-383 bytes) vec2 — jitter from the previous frame
    // Used by TAA to remove jitter contribution from motion vectors of static geometry.
    this.uniformData[94] = this.prevJitterOffsetX;
    this.uniformData[95] = this.prevJitterOffsetY;
    // mipBias (offset 96 = 384 bytes): -0.5 when jitter is active (TAA), 0.0 otherwise.
    // GBuffer shaders use this to request a half-mip-level sharper sample each frame;
    // TAA accumulation then recovers the expected detail without perceptual blur.
    this.uniformData[96] = this.jitterEnabled ? -0.5 : 0.0;
    this.uniformData[97] = 0.0; // _pad_mip
    // unjitteredProjectionMatrix (offset 98-113 = 392-455 bytes) mat4x4
    // Used by SSR viewToScreen() to project view-space hit positions without jitter.
    this.uniformData.set(this.unjitteredProjection, 98);
    // frameIndex (offset 114 = byte 456): monotonically increasing frame counter.
    // Stored as f32 — stays exact up to 2^24 (~16 million frames ≈ 77 hours @60fps).
    this.uniformData[114] = this.frameIndex++;

    // Single GPU write instead of 7 separate writes
    GPUUtils.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    this.isDirty = false;
  }

  // Getters
  public getView(): mat4 {
    return this.view;
  }

  public getProjection(): mat4 {
    return this.projection;
  }

  public getInvProjectionMatrix(): mat4 {
    return this.invProjection;
  }

  public getInvViewProjectionMatrix(): mat4 {
    return this.invViewProjection;
  }

  public getViewProjection(): mat4 {
    return this.viewProjection;
  }

  public setNearPlane(near: number): void {
    this.isDirty = true;
    this.zNear = near;
    this.updateProjection();
  }

  public getNear(): number {
    return this.zNear;
  }

  public setFarPlane(far: number): void {
    this.isDirty = true;
    this.zFar = far;
    this.updateProjection();
  }

  public getFar(): number {
    return this.zFar;
  }

  public getTime(): number {
    return this.time;
  }

  public getDeltaTime(): number {
    return this.deltaTime;
  }

  public resetTime(): void {
    this.time = 0;
  }

  public setFov(fov: number): void {
    this.isDirty = true;
    this.fovRadians = fov * (Math.PI / 180); // Convert degrees to radians
    this.updateProjection();
  }

  public setFovRadians(fovRadians: number): void {
    this.isDirty = true;
    this.fovRadians = fovRadians;
    this.updateProjection();
  }

  public getFov(): number {
    return this.fovRadians;
  }

  public getViewport(): { x0: number; y0: number; width: number; height: number } {
    return this.viewport;
  }

  public getAspectRatio(): number {
    return this.aspectRatio;
  }

  public getPosition(): vec3 {
    return this.eye;
  }

  public getCameraPosition(): vec3 {
    return this.eye;
  }

  public getTarget(): vec3 {
    return this.target;
  }

  public getFront(): vec3 {
    return this.front;
  }

  public getLeft(): vec3 {
    return this.left;
  }

  public getUp(): vec3 {
    return this.up;
  }

  public getOrthoWidth(): number {
    return this.orthoWidth;
  }

  public getOrthoHeight(): number {
    return this.orthoHeight;
  }

  public getOrthoLeft(): number {
    return this.orthoLeft;
  }

  public getOrthoTop(): number {
    return this.orthoTop;
  }

  public isOrthoCentered(): boolean {
    return this.orthoCentered;
  }

  public getBindGroup(): GPUBindGroup {
    return this.bindGroup;
  }

  public getUniformBuffer(): GPUBuffer {
    return this.uniformBuffer;
  }

  public isOrthographic(): boolean {
    return this.isOrtho;
  }

  public setCulledKeys(keys: RenderKey[]): void {
    this.culledKeys = keys;
  }

  public getCulledKeys(): RenderKey[] {
    return this.culledKeys;
  }

  public getIsDirty(): boolean {
    return this.isDirty;
  }

  public setIsDirty(dirty: boolean): void {
    this.isDirty = dirty;
  }

  public setTime(time: number): void {
    this.time = time;
    this.isDirty = true;
  }

  // Jittering methods for temporal anti-aliasing
  public enableJitter(): void {
    this.jitterEnabled = true;
    this.jitterIndex = 0;
    this.isDirty = true;
  }

  public disableJitter(): void {
    this.jitterEnabled = false;
    this.jitterOffsetX = 0;
    this.jitterOffsetY = 0;
    this.prevJitterOffsetX = 0;
    this.prevJitterOffsetY = 0;
    this.isDirty = true;
    this.updateProjection();
  }

  public isJitterEnabled(): boolean {
    return this.jitterEnabled;
  }

  public nextJitter(): void {
    if (!this.jitterEnabled) return;

    // Save current jitter as previous before advancing
    this.prevJitterOffsetX = this.jitterOffsetX / 2.0;
    this.prevJitterOffsetY = this.jitterOffsetY / 2.0;

    // Get next jitter offset from Halton(2,3) 8-point sequence
    const pattern = Camera.HALTON_8[this.jitterIndex];
    this.jitterIndex = (this.jitterIndex + 1) % Camera.HALTON_8.length;

    // NDC offset: jitter = (halton - 0.5) * 2.0 / screenSize
    // Stored as UV-space first (divide by size), then *2 for projection matrix column offsets.
    const offsetX = (pattern[0] - 0.5) / this.viewport.width;
    const offsetY = (pattern[1] - 0.5) / this.viewport.height;

    this.jitterOffsetX = 2.0 * offsetX;
    this.jitterOffsetY = 2.0 * offsetY;

    this.isDirty = true;
    this.updateProjection();
  }

  public getJitterOffset(): [number, number] {
    return [this.jitterOffsetX / 2.0, this.jitterOffsetY / 2.0];
  }

  /** Returns the jitter UV-space offset from the previous frame. Used by TAA to cancel
   *  the jitter contribution from static-geometry motion vectors. */
  public getPrevJitterOffset(): [number, number] {
    return [this.prevJitterOffsetX, this.prevJitterOffsetY];
  }

  /**
   * Returns the view-projection matrix computed WITHOUT jitter offset.
   * Use this for velocity/motion-vector generation so that completely static
   * pixels produce zero velocity instead of a frame-to-frame jitter delta.
   */
  public getUnjitteredViewProjection(): mat4 {
    return this.unjitteredViewProjection;
  }

  /**
   * Returns the INVERSE of the unjittered VP.
   * Use this in the velocity buffer shader to reconstruct world positions —
   * avoids the per-frame jitter-sign alternation that causes camera vibration.
   */
  public getUnjitteredInvViewProjection(): mat4 {
    return this.unjitteredInvViewProjection;
  }
}
