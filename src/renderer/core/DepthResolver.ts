import { Render } from '../core/Render';

export class DepthResolver {
  private renderPipeline!: GPURenderPipeline;
  private bindGroupLayout!: GPUBindGroupLayout;
  private fullscreenVertexBuffer!: GPUBuffer;
  private isLoaded = false;

  public async load(): Promise<void> {
    const device = Render.getInstance().getDevice();

    // Create fullscreen quad vertex buffer
    const quadVertices = new Float32Array([
      -1.0,
      -1.0, // Bottom left
      1.0,
      -1.0, // Bottom right
      -1.0,
      1.0, // Top left
      1.0,
      1.0, // Top right
    ]);

    this.fullscreenVertexBuffer = device.createBuffer({
      label: 'Depth Resolve Vertex Buffer',
      size: quadVertices.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Float32Array(this.fullscreenVertexBuffer.getMappedRange()).set(quadVertices);
    this.fullscreenVertexBuffer.unmap();

    // Vertex shader - simple fullscreen quad
    const vertexShaderCode = `
      @vertex
      fn vs_main(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
        return vec4<f32>(position, 0.0, 1.0);
      }
    `;

    // Fragment shader - sample MSAA depth and output depth
    const fragmentShaderCode = `
      @group(0) @binding(0) var msaa_depth_texture: texture_depth_multisampled_2d;

      @fragment
      fn fs_main(@builtin(position) coord: vec4<f32>) -> @builtin(frag_depth) f32 {
        let pixel_coord = vec2<i32>(coord.xy);
        
        // Sample all MSAA samples and find the closest (minimum depth)
        let sample_count = 4u; // 4x MSAA
        var min_depth = 1.0;
        
        for (var sample_index = 0u; sample_index < sample_count; sample_index++) {
          let depth_sample = textureLoad(msaa_depth_texture, pixel_coord, sample_index);
          min_depth = min(min_depth, depth_sample);
        }
        
        return min_depth;
      }
    `;

    // Create shader modules
    const vertexShaderModule = device.createShaderModule({
      label: 'Depth Resolve Vertex Shader',
      code: vertexShaderCode,
    });

    const fragmentShaderModule = device.createShaderModule({
      label: 'Depth Resolve Fragment Shader',
      code: fragmentShaderCode,
    });

    // Create bind group layout
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'Depth Resolve Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: 'depth',
            viewDimension: '2d',
            multisampled: true,
          },
        },
      ],
    });

    // Create render pipeline
    this.renderPipeline = device.createRenderPipeline({
      label: 'Depth Resolve Render Pipeline',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      vertex: {
        module: vertexShaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 8, // 2 floats * 4 bytes
            attributes: [
              {
                format: 'float32x2',
                offset: 0,
                shaderLocation: 0,
              },
            ],
          },
        ],
      },
      fragment: {
        module: fragmentShaderModule,
        entryPoint: 'fs_main',
        targets: [], // No color output, only depth
      },
      primitive: {
        topology: 'triangle-strip',
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'always',
        format: 'depth32float',
      },
    });

    this.isLoaded = true;
  }

  public resolve(msaaDepthTexture: GPUTexture, singleSampleDepthTexture: GPUTexture): void {
    if (!this.isLoaded) {
      console.error('DepthResolver not loaded');
      return;
    }

    const device = Render.getInstance().getDevice();
    const commandEncoder = Render.getInstance().getCommandEncoder();

    // Create bind group
    const bindGroup = device.createBindGroup({
      label: 'Depth Resolve Bind Group',
      layout: this.bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: msaaDepthTexture.createView(),
        },
      ],
    });

    // Create render pass to resolve depth
    const renderPass = commandEncoder.beginRenderPass({
      label: 'Depth Resolve Render Pass',
      colorAttachments: [], // No color attachments
      depthStencilAttachment: {
        view: singleSampleDepthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.setVertexBuffer(0, this.fullscreenVertexBuffer);
    renderPass.draw(4); // Triangle strip: 4 vertices

    renderPass.end();
  }
  public destroy(): void {
    if (this.fullscreenVertexBuffer) {
      this.fullscreenVertexBuffer.destroy();
    }
    this.isLoaded = false;
  }
}
