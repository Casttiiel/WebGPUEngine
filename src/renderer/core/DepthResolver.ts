import { Render } from '../core/Render';
import { Technique } from '../resources/Technique';
import { Mesh } from '../resources/Mesh';

export class DepthResolver {
  private depthResolveTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private depthBindGroup!: GPUBindGroup;
  private isLoaded = false;
  public async load(): Promise<void> {
    // Load fullscreen quad mesh and technique using existing classes
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');
    this.depthResolveTechnique = await Technique.get('depth_resolve.tech');

    this.isLoaded = true;
  }
  public resolve(msaaDepthTexture: GPUTexture, singleSampleDepthTexture: GPUTexture): void {
    if (!this.isLoaded) {
      console.error('DepthResolver not loaded');
      return;
    }

    const device = Render.getInstance().getDevice();
    const commandEncoder = Render.getInstance().getCommandEncoder(); // Create bind group for the MSAA depth texture
    const bindGroupLayout = this.depthResolveTechnique.getBindGroupLayout(0);
    if (!bindGroupLayout) {
      console.error('Failed to get bind group layout from depth resolve technique');
      return;
    }

    this.depthBindGroup = device.createBindGroup({
      label: 'Depth Resolve Bind Group',
      layout: bindGroupLayout,
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

    // Use technique and mesh like other components
    this.depthResolveTechnique.activatePipeline(renderPass);
    this.fullscreenQuadMesh.activate(renderPass);
    renderPass.setBindGroup(0, this.depthBindGroup);
    this.fullscreenQuadMesh.renderGroup(renderPass);

    renderPass.end();
  }
  public destroy(): void {
    // Mesh and Technique are managed by ResourceManager, no need to destroy manually
    this.isLoaded = false;
  }
}
