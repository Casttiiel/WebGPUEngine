import { AntialiasingComponent } from '../../components/render/AntialiasingComponent';
import { CameraComponent } from '../../components/render/CameraComponent';
import { ToneMappingComponent } from '../../components/render/ToneMappingComponent';
import { Engine } from '../../core/engine/Engine';
import { DeferredRenderer } from '../../renderer/core/DeferredRenderer';
import { Render } from '../../renderer/core/render';
import { RenderManager } from '../../renderer/core/RenderManager';
import { Mesh } from '../../renderer/resources/Mesh';
import { Technique } from '../../renderer/resources/Technique';
import { RenderCategory } from '../../types/RenderCategory.enum';
import { Module } from '../core/Module';

export class ModuleRender extends Module {
  private deferred: DeferredRenderer;
  private debugControlsAdded: boolean = false;

  // Buffer global para datos de cámara
  private globalUniformBuffer!: GPUBuffer;
  private globalBindGroup!: GPUBindGroup;

  //Presentation data
  private presentationTechnique!: Technique;
  private fullscreenQuadMesh!: Mesh;
  private presentationBindGroup!: GPUBindGroup | null;

  // Debug values para Tweakpane
  private debugValues = {
    drawCallsSolids: { name: 'Draw Calls (Solids)', value: 0 },
    drawCallsTransparent: { name: 'Draw Calls (Transparent)', value: 0 },
    totalDrawCalls: { name: 'Total Draw Calls', value: 0 },
    resolution: { name: 'Resolution', value: '0x0' },
  };

  constructor(name: string) {
    super(name);
    this.deferred = new DeferredRenderer();
  }

  public async start(): Promise<boolean> {
    await this.deferred.load();
    this.onResolutionUpdated();
    this.initializeUniformBuffers();
    await this.initializePresentationData();
    return true;
  }

  public onResolutionUpdated(): void {
    this.deferred.create(Render.width, Render.height);
    this.presentationBindGroup = null;
  }

  public generateFrame(): void {
    Render.getInstance().beginFrame();

    const mainCamera = Engine.getEntities().getEntityByName('MainCamera');
    const cameraComponent = mainCamera?.getComponent('camera') as CameraComponent;
    const camera = cameraComponent.getCamera();

    // Actualizar buffer uniforme global solo con view y projection
    this.updateGlobalUniforms(
      new Float32Array(camera.getView()),
      new Float32Array(camera.getProjection()),
    );
    RenderManager.getInstance().setCamera(camera);

    let result = this.deferred.render(camera);

    if (mainCamera?.hasComponent('tone_mapping')) {
      const toneMapping = mainCamera.getComponent('tone_mapping') as ToneMappingComponent;
      result = toneMapping.apply(result);
    }

    if (mainCamera?.hasComponent('antialiasing')) {
      const antialiasing = mainCamera.getComponent('antialiasing') as AntialiasingComponent;
      result = antialiasing.apply(result);
    }

    this.presentResult(result);

    Render.getInstance().endFrame();
  }

  private presentResult(result: GPUTextureView): void {
    const render = Render.getInstance();
    const device = render.getDevice();

    if (!this.presentationBindGroup) {
      const sampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
      });

      this.presentationBindGroup = device.createBindGroup({
        label: `presentation_bindgroup`,
        layout: this.presentationTechnique.getPipeline().getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: result,
          },
          {
            binding: 1,
            resource: sampler,
          },
        ],
      });
    }

    const pass = render.getCommandEncoder().beginRenderPass({
      colorAttachments: [
        {
          view: render.getContext().getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });

    // Configurar el viewport y scissor para asegurar que todo el canvas sea utilizable
    pass.setViewport(
      0,
      0, // Offset X,Y
      render.getCanvas().width, // Width
      render.getCanvas().height, // Height
      0.0,
      1.0, // Min/max depth
    );

    pass.setScissorRect(
      0,
      0, // Offset X,Y
      render.getCanvas().width, // Width
      render.getCanvas().height, // Height
    );

    // 1. Activar el pipeline
    this.presentationTechnique.activatePipeline(pass);

    // 2. Activar mesh data
    this.fullscreenQuadMesh.activate(pass);

    // 3. Activar bind groups
    pass.setBindGroup(0, this.presentationBindGroup);

    // 4. Dibujar la mesh
    this.fullscreenQuadMesh.renderGroup(pass);

    pass.end();
  }

  public stop(): void {
    throw new Error('Method not implemented.');
  }

  public update(dt: number): void {
    // Actualizar valores de debug
    const renderManager = RenderManager.getInstance();
    this.debugValues.drawCallsSolids.value = renderManager.getDrawCallsForCategory(
      RenderCategory.SOLIDS,
    );
    this.debugValues.drawCallsTransparent.value = renderManager.getDrawCallsForCategory(
      RenderCategory.TRANSPARENT,
    );
    this.debugValues.totalDrawCalls.value =
      this.debugValues.drawCallsSolids.value + this.debugValues.drawCallsTransparent.value;
    this.debugValues.resolution.value = `${Render.width}x${Render.height}`;
  }

  public override renderInMenu(): void {
    if (this.debugControlsAdded) return;

    // Render Stats
    this.addDebugControl(
      this.debugValues.drawCallsSolids,
      'value',
      this.debugValues.drawCallsSolids.name,
    );
    this.addDebugControl(
      this.debugValues.drawCallsTransparent,
      'value',
      this.debugValues.drawCallsTransparent.name,
    );
    this.addDebugControl(
      this.debugValues.totalDrawCalls,
      'value',
      this.debugValues.totalDrawCalls.name,
    );
    this.addDebugControl(this.debugValues.resolution, 'value', this.debugValues.resolution.name);

    this.debugControlsAdded = true;
  }

  public renderDebug(): void {
    throw new Error('Method not implemented.');
  }

  private initializeUniformBuffers(): void {
    const render = Render.getInstance();

    // Crear buffer uniforme global para las matrices de la cámara
    this.globalUniformBuffer = render.getDevice().createBuffer({
      label: `global uniform buffer`,
      size: (16 * 4) + (16 * 4) + 16, // viewMatrix(64) + projectionMatrix(64) + sourceSize(16 aligned)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Crear el layout para el bind group global
    const globalBindGroupLayout = render.getDevice().createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    // Crear el bind group global
    this.globalBindGroup = render.getDevice().createBindGroup({
      label: `global uniform bind group`,
      layout: globalBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.globalUniformBuffer },
        },
      ],
    });
  }

  private async initializePresentationData(): Promise<void> {
    this.fullscreenQuadMesh = await Mesh.get('fullscreenquad.obj');

    this.presentationTechnique = await Technique.get('presentation.tech');
  }

  public updateGlobalUniforms(viewMatrix: Float32Array, projectionMatrix: Float32Array): void {
    const render = Render.getInstance();

    // Escribir la matriz de vista con el nombre correcto viewMatrix
    render.getDevice().queue.writeBuffer(
      this.globalUniformBuffer,
      0, // viewMatrix offset
      viewMatrix.buffer,
    );

    // Escribir la matriz de proyección con el nombre correcto projectionMatrix
    render.getDevice().queue.writeBuffer(
      this.globalUniformBuffer,
      16 * 4, // projectionMatrix offset
      projectionMatrix.buffer,
    );

    render.getDevice().queue.writeBuffer(
      this.globalUniformBuffer,
      16 * 4 * 2, // view and projectionMatrix offset
      new Float32Array([Render.width, Render.height]),
    );
  }

  public getGlobalBindGroup(): GPUBindGroup {
    if (!this.globalBindGroup) {
      throw new Error('Global bind group is not initialized');
    }
    return this.globalBindGroup;
  }
}
