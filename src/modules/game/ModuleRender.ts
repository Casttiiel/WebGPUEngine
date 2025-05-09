import { CameraComponent } from "../../components/render/CameraComponent";
import { Engine } from "../../core/engine/Engine";
import { DeferredRenderer } from "../../renderer/core/DeferredRenderer";
import { Render } from "../../renderer/core/render";
import { RenderManager } from "../../renderer/core/RenderManager";
import { RenderCategory } from "../../types/RenderCategory.enum";
import { Module } from "../core/Module";

export class ModuleRender extends Module {
  private deferred: DeferredRenderer;
  private debugControlsAdded: boolean = false;

  // Buffer global para datos de cámara
  private globalUniformBuffer!: GPUBuffer;
  private globalBindGroupLayout!: GPUBindGroupLayout;
  private globalBindGroup!: GPUBindGroup;

  // Debug values para Tweakpane
  private debugValues = {
    drawCallsSolids: { name: 'Draw Calls (Solids)', value: 0 },
    drawCallsTransparent: { name: 'Draw Calls (Transparent)', value: 0 },
    totalDrawCalls: { name: 'Total Draw Calls', value: 0 },
    resolution: { name: 'Resolution', value: '0x0' }
  };

  constructor(name: string) {
    super(name);
    this.deferred = new DeferredRenderer();
  }

  public async start(): Promise<boolean> {
    //this.setupDeferredOutput();
    this.onResolutionUpdated();
    this.initializeUniformBuffers();
    return true;
  }

  /*private setupDeferredOutput(): void {
    if (this.deferredOutput.getWidth() !== Render.width || this.deferredOutput.getHeight() !== Render.height) {
      this.deferredOutput.createRT("g_deferred_output.dds", Render.width, Render.height, "rgba16float", "", true);
    }

    if (this.shineOutput.getWidth() !== Render.width || this.shineOutput.getHeight() !== Render.height) {
      this.shineOutput.createRT("g_shine_output.dds", Render.width, Render.height, "rgba16float");
    }
  }*/

  private onResolutionUpdated(): void {
    this.deferred.create(Render.width, Render.height);
  }

  public generateFrame(): void {
    Render.getInstance().beginFrame();

    const mainCamera = Engine.getEntities().getEntityByName("MainCamera");
    const cameraComponent = mainCamera.getComponent("camera") as CameraComponent;
    const camera = cameraComponent.getCamera();

    // Actualizar buffer uniforme global solo con view y projection
    this.updateGlobalUniforms(
      new Float32Array(camera.getView()),
      new Float32Array(camera.getProjection())
    );
    RenderManager.getInstance().setCamera(camera);

    //this.setupDeferredOutput();
    this.deferred.render(camera);

    Render.getInstance().endFrame();
  }

  public stop(): void {
    throw new Error("Method not implemented.");
  }

  public update(dt: number): void {
    // Actualizar valores de debug
    const renderManager = RenderManager.getInstance();
    this.debugValues.drawCallsSolids.value = renderManager.getDrawCallsForCategory(RenderCategory.SOLIDS);
    this.debugValues.drawCallsTransparent.value = renderManager.getDrawCallsForCategory(RenderCategory.TRANSPARENT);
    this.debugValues.totalDrawCalls.value = this.debugValues.drawCallsSolids.value + this.debugValues.drawCallsTransparent.value;
    this.debugValues.resolution.value = `${Render.width}x${Render.height}`;
  }

  public renderInMenu(): void {
    if (this.debugControlsAdded) return;

    // Render Stats
    this.addDebugControl(this.debugValues.drawCallsSolids, 'value', this.debugValues.drawCallsSolids.name);
    this.addDebugControl(this.debugValues.drawCallsTransparent, 'value', this.debugValues.drawCallsTransparent.name);
    this.addDebugControl(this.debugValues.totalDrawCalls, 'value', this.debugValues.totalDrawCalls.name);
    this.addDebugControl(this.debugValues.resolution, 'value', this.debugValues.resolution.name);

    this.debugControlsAdded = true;
  }

  public renderDebug(): void {
    throw new Error("Method not implemented.");
  }

  private initializeUniformBuffers(): void {
    const render = Render.getInstance();

    // Crear buffer uniforme global para las matrices de la cámara
    this.globalUniformBuffer = render.getDevice().createBuffer({
      label: `global uniform buffer`,
      size: 2 * 16 * 4, // 2 matrices 4x4 (view, projection)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Crear el layout para el bind group global
    this.globalBindGroupLayout = render.getDevice().createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' }
        }
      ]
    });

    // Crear el bind group global
    this.globalBindGroup = render.getDevice().createBindGroup({
      label: `global uniform bind group`,
      layout: this.globalBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.globalUniformBuffer }
        }
      ]
    });
  }

  public updateGlobalUniforms(viewMatrix: Float32Array, projectionMatrix: Float32Array): void {
    const render = Render.getInstance();

    // Escribir la matriz de vista con el nombre correcto viewMatrix
    render.getDevice().queue.writeBuffer(
      this.globalUniformBuffer,
      0,  // viewMatrix offset
      viewMatrix.buffer
    );

    // Escribir la matriz de proyección con el nombre correcto projectionMatrix
    render.getDevice().queue.writeBuffer(
      this.globalUniformBuffer,
      16 * 4,  // projectionMatrix offset
      projectionMatrix.buffer
    );
  }

  public getGlobalBindGroup(): GPUBindGroup {
    if (!this.globalBindGroup) {
      throw new Error('Global bind group is not initialized');
    }
    return this.globalBindGroup;
  }

  public getGlobalBindGroupLayout(): GPUBindGroupLayout {
    return this.globalBindGroupLayout;
  }
}