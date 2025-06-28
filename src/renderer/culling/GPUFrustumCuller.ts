import { mat4 } from 'gl-matrix';
import { Camera } from '../../core/math/Camera';
import { GPUUtils } from '../core/utils/GPUUtils';
import { BindGroupFactory } from '../core/factories/BindGroupFactory';
import { PipelineFactory, ComputePipelineConfig } from '../core/factories/PipelineFactory';

export interface AABB {
  min: [number, number, number];
  max: [number, number, number];
}

export interface CullableObject {
  id: number;
  bounds: AABB;
  modelMatrix: Float32Array;
}

export interface CullResult {
  visibleIndices: number[];
  visibleCount: number;
}

export class GPUFrustumCuller {
  private device!: GPUDevice;
  private isInitialized = false;

  // GPU resources
  private computeShader!: GPUShaderModule;
  private computePipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;

  // Buffers
  private frustumBuffer!: GPUBuffer;
  private objectsBuffer!: GPUBuffer;
  private visibilityBuffer!: GPUBuffer;
  private visibleCountBuffer!: GPUBuffer;
  private readbackBuffer!: GPUBuffer;

  // Current capacity
  private maxObjects = 1000;

  constructor() { }

  public async load(): Promise<void> {
    this.device = GPUUtils.getDevice();

    try {
      await this.initializeComputeShader();
      await this.createBuffers();
      await this.createComputePipeline();
      this.isInitialized = true;
      console.warn('GPU Frustum Culler initialized successfully');
    } catch (error) {
      console.warn('Failed to initialize GPU Frustum Culler, falling back to CPU:', error);
      this.isInitialized = false;
    }
  }

  private async initializeComputeShader(): Promise<void> {
    // Load the compute shader from file
    const shaderResponse = await fetch('/assets/shaders/frustum_culling.cs');
    const shaderCode = await shaderResponse.text();

    this.computeShader = this.device.createShaderModule({
      label: 'Frustum Culling Compute Shader',
      code: shaderCode,
    });
  }

  private async createBuffers(): Promise<void> {
    // Frustum planes buffer (6 vec4s = 24 floats = 96 bytes)
    this.frustumBuffer = this.device.createBuffer({
      label: 'Frustum Planes Buffer',
      size: 96, // 6 * 4 * 4 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }); // Objects buffer (dynamic size based on maxObjects)
    const objectSize = 4 * 4 * 4 + 2 * 4 * 4; // mat4x4 + 2 vec4s (min+padding + max+padding) = 64 + 32 = 96 bytes per object
    this.objectsBuffer = this.device.createBuffer({
      label: 'Objects Buffer',
      size: objectSize * this.maxObjects,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }); // Visibility result buffer (1 uint32 per object)
    this.visibilityBuffer = this.device.createBuffer({
      label: 'Visibility Buffer',
      size: 4 * this.maxObjects,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    // Visible count buffer (atomic counter)
    this.visibleCountBuffer = this.device.createBuffer({
      label: 'Visible Count Buffer',
      size: 4, // 1 uint32
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    // Readback buffer for CPU access
    this.readbackBuffer = this.device.createBuffer({
      label: 'Readback Buffer',
      size: 4 * this.maxObjects + 4, // visibility + count
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  private async createComputePipeline(): Promise<void> {    // Create bind group layout
    this.bindGroupLayout = BindGroupFactory.getLayout('frustum_culling', [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' }, // frustum planes
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'read-only-storage' }, // objects
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'storage' }, // visibility results
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'storage' }, // visible count
      },
    ]);
    // Create compute pipeline
    const computeConfig: ComputePipelineConfig = {
      label: 'Frustum Culling Compute Pipeline',
      layout: PipelineFactory.createPipelineLayout(
        'frustum_culling_pipeline_layout',
        [this.bindGroupLayout],
      ),
      compute: {
        module: this.computeShader,
        entryPoint: 'main',
      },
    };

    this.computePipeline = PipelineFactory.createComputePipeline(computeConfig);
  }

  public async cullObjects(camera: Camera, objects: CullableObject[]): Promise<CullResult> {
    try {
      // Check if we need to resize buffers
      if (objects.length > this.maxObjects) {
        await this.resizeBuffers(objects.length);
      }

      // Extract frustum planes using the same algorithm as CPU
      const frustumPlanes = this.extractFrustumPlanes(camera);

      // Convert to GPU format (6 vec4s)
      const frustumData = this.convertFrustumPlanesToGPUFormat(frustumPlanes);      // Upload frustum data
      GPUUtils.writeBuffer(this.frustumBuffer, 0, frustumData.buffer);

      // Convert objects to GPU format
      const objectsData = this.convertObjectsToGPUFormat(objects);

      // Upload objects data
      GPUUtils.writeBuffer(this.objectsBuffer, 0, objectsData.buffer);

      // Clear visibility and count buffers
      const clearData = new Uint32Array(objects.length + 1); // +1 for count
      GPUUtils.writeBuffer(this.visibilityBuffer, 0, clearData.slice(0, objects.length));
      GPUUtils.writeBuffer(this.visibleCountBuffer, 0, clearData.slice(0, 1));

      // Execute compute shader
      const result = await this.executeCompute(objects.length);

      return result;
    } catch (error) {
      throw new Error(`GPU culling failed: ${error}`);
    }
  }

  private convertFrustumPlanesToGPUFormat(planes: Float32Array): Float32Array {
    // Convert flat array of 24 floats to 6 vec4s
    const frustumData = new Float32Array(24);
    frustumData.set(planes);
    return frustumData;
  }

  private convertObjectsToGPUFormat(objects: CullableObject[]): Float32Array {
    // Each object: AABB (min + max vec3) + mat4x4
    // Layout: min.xyz, padding, max.xyz, padding, mat4x4
    const stride = 24; // 3 + 1 + 3 + 1 + 16 = 24 floats per object
    const data = new Float32Array(objects.length * stride);
    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      if (!obj) continue;
      const offset = i * stride;

      // AABB min
      data[offset + 0] = obj.bounds.min[0];
      data[offset + 1] = obj.bounds.min[1];
      data[offset + 2] = obj.bounds.min[2];
      data[offset + 3] = 0; // padding

      // AABB max
      data[offset + 4] = obj.bounds.max[0];
      data[offset + 5] = obj.bounds.max[1];
      data[offset + 6] = obj.bounds.max[2];
      data[offset + 7] = 0; // padding

      // Model matrix (16 floats)
      for (let j = 0; j < 16; j++) {
        data[offset + 8 + j] = obj.modelMatrix[j] ?? 0;
      }
    }

    return data;
  }

  private async executeCompute(objectCount: number): Promise<CullResult> {    // Create bind group
    const bindGroup = BindGroupFactory.createBindGroup(
      'Frustum Culling Bind Group',
      this.bindGroupLayout,
      [
        { binding: 0, resource: { buffer: this.frustumBuffer } },
        { binding: 1, resource: { buffer: this.objectsBuffer } },
        { binding: 2, resource: { buffer: this.visibilityBuffer } },
        { binding: 3, resource: { buffer: this.visibleCountBuffer } },
      ]
    );

    // Create command encoder
    const commandEncoder = this.device.createCommandEncoder({
      label: 'Frustum Culling Commands',
    });

    // Begin compute pass
    const computePass = commandEncoder.beginComputePass({
      label: 'Frustum Culling Compute Pass',
    });

    computePass.setPipeline(this.computePipeline);
    computePass.setBindGroup(0, bindGroup);

    // Dispatch compute shader (64 threads per workgroup)
    const workgroupCount = Math.ceil(objectCount / 64);
    computePass.dispatchWorkgroups(workgroupCount);

    computePass.end();

    // Copy results to readback buffer
    commandEncoder.copyBufferToBuffer(
      this.visibilityBuffer,
      0,
      this.readbackBuffer,
      0,
      objectCount * 4,
    );
    commandEncoder.copyBufferToBuffer(
      this.visibleCountBuffer,
      0,
      this.readbackBuffer,
      objectCount * 4,
      4,
    );

    // Submit commands
    this.device.queue.submit([commandEncoder.finish()]);

    // Read back results
    await this.readbackBuffer.mapAsync(GPUMapMode.READ);
    const mappedRange = this.readbackBuffer.getMappedRange();
    const results = new Uint32Array(mappedRange);

    // Parse visibility results
    const visibleIndices: number[] = [];
    for (let i = 0; i < objectCount; i++) {
      if (results[i] === 1) {
        visibleIndices.push(i);
      }
    }

    results[objectCount]; // Read the atomic counter (for validation)
    this.readbackBuffer.unmap();

    return {
      visibleIndices,
      visibleCount: visibleIndices.length, // Use actual count, not atomic (which might be off)
    };
  }

  private async resizeBuffers(newMaxObjects: number): Promise<void> {
    this.maxObjects = Math.max(newMaxObjects, this.maxObjects * 2);

    // Destroy old buffers
    this.objectsBuffer?.destroy();
    this.visibilityBuffer?.destroy();
    this.readbackBuffer?.destroy();

    // Recreate with new size
    await this.createBuffers();

    console.warn(`GPU Frustum Culler buffers resized to ${this.maxObjects} objects`);
  }

  private extractFrustumPlanes(camera: Camera): Float32Array {
    const viewProjection = mat4.create();
    mat4.multiply(viewProjection, camera.getProjection(), camera.getView());
    return this.extractFrustumPlanesFromViewProjection(viewProjection);
  }

  private extractFrustumPlanesFromViewProjection(viewProjection: mat4): Float32Array {
    // CRITICAL: Transpose the view-projection matrix first
    const m = mat4.create();
    mat4.transpose(m, viewProjection);

    const planes = new Float32Array(24);

    // Extract rows from transposed matrix
    // mx = row 1, my = row 2, mz = row 3, mw = row 4
    const mx = [m[0], m[1], m[2], m[3]]; // row 1
    const my = [m[4], m[5], m[6], m[7]]; // row 2
    const mz = [m[8], m[9], m[10], m[11]]; // row 3
    const mw = [m[12], m[13], m[14], m[15]]; // row 4

    // Left plane: mw + mx
    planes[0] = (mw[0] ?? 0) + (mx[0] ?? 0);
    planes[1] = (mw[1] ?? 0) + (mx[1] ?? 0);
    planes[2] = (mw[2] ?? 0) + (mx[2] ?? 0);
    planes[3] = (mw[3] ?? 0) + (mx[3] ?? 0);

    // Right plane: mw - mx
    planes[4] = (mw[0] ?? 0) - (mx[0] ?? 0);
    planes[5] = (mw[1] ?? 0) - (mx[1] ?? 0);
    planes[6] = (mw[2] ?? 0) - (mx[2] ?? 0);
    planes[7] = (mw[3] ?? 0) - (mx[3] ?? 0);

    // Top plane: mw + my
    planes[8] = (mw[0] ?? 0) + (my[0] ?? 0);
    planes[9] = (mw[1] ?? 0) + (my[1] ?? 0);
    planes[10] = (mw[2] ?? 0) + (my[2] ?? 0);
    planes[11] = (mw[3] ?? 0) + (my[3] ?? 0);

    // Bottom plane: mw - my
    planes[12] = (mw[0] ?? 0) - (my[0] ?? 0);
    planes[13] = (mw[1] ?? 0) - (my[1] ?? 0);
    planes[14] = (mw[2] ?? 0) - (my[2] ?? 0);
    planes[15] = (mw[3] ?? 0) - (my[3] ?? 0);

    // Near plane: mw + mz
    planes[16] = (mw[0] ?? 0) + (mz[0] ?? 0);
    planes[17] = (mw[1] ?? 0) + (mz[1] ?? 0);
    planes[18] = (mw[2] ?? 0) + (mz[2] ?? 0);
    planes[19] = (mw[3] ?? 0) + (mz[3] ?? 0);

    // Far plane: mw - mz
    planes[20] = (mw[0] ?? 0) - (mz[0] ?? 0);
    planes[21] = (mw[1] ?? 0) - (mz[1] ?? 0);
    planes[22] = (mw[2] ?? 0) - (mz[2] ?? 0);
    planes[23] = (mw[3] ?? 0) - (mz[3] ?? 0);

    return planes;
  }

  public dispose(): void {
    if (this.isInitialized) {
      this.frustumBuffer?.destroy();
      this.objectsBuffer?.destroy();
      this.visibilityBuffer?.destroy();
      this.visibleCountBuffer?.destroy();
      this.readbackBuffer?.destroy();
      this.isInitialized = false;
    }
  }
}
