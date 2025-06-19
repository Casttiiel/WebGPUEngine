import { Render } from './Render';
import { RenderToTexture } from './RenderToTexture';
import { Mesh } from '../resources/Mesh';
import { Technique } from '../resources/Technique';

/**
 * Utility class for computing scene average luminance using a progressive reduction approach.
 * This is used by the tone mapping system for auto-exposure calculation.
 */
export class LuminanceCalculator {
  // Luminance range in log2 space
  public static readonly LOG_LUMINANCE_MIN = -10;
  public static readonly LOG_LUMINANCE_MAX = 2;
  public static readonly ADAPTATION_RATE = 1.0; // Seconds for full adaptation

  private luminanceMesh!: Mesh;
  private luminanceTechnique!: Technique;
  private reductionTechnique!: Technique;

  // We'll use a pyramid of textures for reduction, each half the size of the previous
  private luminanceTextures: RenderToTexture[] = [];
  private numMips = 0;
  private uniformBuffer!: GPUBuffer;
  private bindGroups: GPUBindGroup[] = [];

  constructor() {}

  public async initialize(): Promise<void> {
    this.luminanceMesh = await Mesh.get('fullscreenquad.obj');
    this.luminanceTechnique = await Technique.get('luminance.tech');
    this.reductionTechnique = await Technique.get('luminance_reduce.tech');

    await this.createResources();
  }

  private async createResources(): Promise<void> {
    const device = Render.getInstance().getDevice();

    // Create uniform buffer for parameters
    this.uniformBuffer = device.createBuffer({
      size: 16, // vec2 texelSize + vec2 padding
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'Luminance uniforms',
    });

    // Calculate how many mip levels we need to reduce to 1x1
    const maxDim = Math.max(Render.width, Render.height);
    this.numMips = Math.floor(Math.log2(maxDim)) + 1;

    // Create the luminance texture pyramid
    this.luminanceTextures = [];
    for (let i = 0; i < this.numMips; i++) {
      const size = Math.max(1, Math.floor(maxDim / Math.pow(2, i)));
      const rt = new RenderToTexture();
      rt.createRT(`luminance_${i}.dds`, size, size, 'r16float');
      this.luminanceTextures.push(rt);
    }

    // Create bind groups for each reduction step
    this.bindGroups = [];
    for (let i = 0; i < this.numMips - 1; i++) {
      const texSize = Math.max(1, Math.floor(maxDim / Math.pow(2, i + 1)));
      const uniformValues = new Float32Array([1.0 / texSize, 1.0 / texSize, 0.0, 0.0]);
      device.queue.writeBuffer(this.uniformBuffer, 0, uniformValues);

      const layout = this.reductionTechnique.getBindGroupLayout(0);
      if (!layout) {
        throw new Error('Failed to get reduction technique bind group layout');
      }

      const view = this.luminanceTextures[i]?.getView();
      if (!view) {
        throw new Error(`Failed to get view for luminance texture ${i}`);
      }
      const bindGroup = device.createBindGroup({
        layout,
        entries: [
          {
            binding: 0,
            resource: view,
          },
          {
            binding: 1,
            resource: device.createSampler({
              magFilter: 'linear',
              minFilter: 'linear',
              mipmapFilter: 'linear',
            }),
          },
          {
            binding: 2,
            resource: { buffer: this.uniformBuffer },
          },
        ],
      });
      this.bindGroups.push(bindGroup);
    }
  }

  public async resize(): Promise<void> {
    await this.createResources();
  }

  public computeSceneLuminance(hdrColor: GPUTextureView): void {
    const render = Render.getInstance();
    const device = render.getDevice();
    const commandEncoder = render.getCommandEncoder();

    // Initial luminance pass
    const view = this.luminanceTextures[0]?.getView();
    if (!view) {
      throw new Error('Failed to get initial luminance texture view');
    }

    const initialPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    this.luminanceTechnique.activatePipeline(initialPass);
    this.luminanceMesh.activate(initialPass);

    // Create bind group for input texture
    const layout = this.luminanceTechnique.getBindGroupLayout(0);
    if (!layout) {
      throw new Error('Failed to get luminance technique bind group layout');
    }

    const inputBindGroup = device.createBindGroup({
      layout,
      entries: [
        {
          binding: 0,
          resource: hdrColor,
        },
        {
          binding: 1,
          resource: device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
          }),
        },
      ],
    });
    initialPass.setBindGroup(0, inputBindGroup);
    this.luminanceMesh.renderGroup(initialPass);
    initialPass.end();

    // Reduction passes
    for (let i = 0; i < this.numMips - 1; i++) {
      const reductionView = this.luminanceTextures[i + 1]?.getView();
      if (!reductionView) {
        throw new Error(`Failed to get reduction texture view ${i + 1}`);
      }

      const reductionPass = commandEncoder.beginRenderPass({
        colorAttachments: [
          {
            view: reductionView,
            clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });

      this.reductionTechnique.activatePipeline(reductionPass);
      this.luminanceMesh.activate(reductionPass);
      reductionPass.setBindGroup(0, this.bindGroups[i]);
      this.luminanceMesh.renderGroup(reductionPass);
      reductionPass.end();
    }
  }

  public getAverageLuminance(): GPUTextureView {
    // Return the 1x1 texture containing the final average luminance
    const view = this.luminanceTextures[this.numMips - 1]?.getView();
    if (!view) {
      throw new Error('Failed to get final average luminance texture view');
    }
    return view;
  }

  public getCurrentLuminance(): number | undefined {
    // El último valor de luminancia estará en el último nivel de la pirámide (1x1)
    const lastLevel = this.luminanceTextures[this.numMips - 1];
    if (!lastLevel) return undefined;

    // Leer el valor de luminancia
    // Nota: En WebGPU aún no podemos leer directamente la textura,
    // así que esto es una aproximación basada en el último valor calculado
    // Cuando esté disponible readPixels, podríamos usar eso
    return 0.5; // Por ahora devolvemos un valor medio
  }

  public destroy(): void {
    this.uniformBuffer?.destroy();
    for (const tex of this.luminanceTextures) {
      tex.destroy();
    }
    this.luminanceTextures = [];
  }
}
