import { ReflectionProbeComponent } from '../../components/render/ReflectionProbeComponent';
import { Engine } from '../../core/engine/Engine';
import { ResourceManager } from '../../core/engine/ResourceManager';
import { Cubemap } from '../../renderer/resources/Cubemap';
import { HDRTexture } from '../../renderer/resources/HDRTexture';
import { AmbientEnvironmentData } from '../../types/AmbientEnvironmentData.type';
import { Interpolator } from '../../types/Interpolator.interface';
import { KeyCode } from '../../types/KeyCode.enum';
import { Module } from '../core/Module';
import { vec3 } from 'gl-matrix';
import { RenderManagerV2 as RenderManager } from '../../renderer/core/managers/RenderManagerV2';
import { GPUUtils } from '../../renderer/core/utils/GPUUtils';
import { DeferredRenderer } from '../../renderer/core/pipeline/DeferredRenderer';
import { Entity } from '../../core/ecs/Entity';
import { CameraComponent } from '../../components/render/CameraComponent';
import { IrradianceGenerator } from '../../renderer/core/IrradianceGenerator';
import { ResourceType } from '../../types/ResourceType.enum';
import { Render } from '../../renderer/core/pipeline/Render';

interface EnvironmentBlendState {
  startData: AmbientEnvironmentData;
  targetData: AmbientEnvironmentData;
  blendTime: number;
  blendedWeight: number;
  interpolator: Interpolator;
}

export class ModuleEnvironmentManager extends Module {
  private ssrEnvironmentTexture!: Cubemap;
  private skyboxTexture!: HDRTexture;
  private ambientLightData!: AmbientEnvironmentData;

  private blendState: EnvironmentBlendState | null = null;

  // Generador de irradiance
  private irradianceGenerator: IrradianceGenerator | null = null;

  constructor(name: string) {
    super(name);
  }

  public async start(): Promise<boolean> {
    const response = await ResourceManager.fetch(`/data/environment.json`);
    const jsonData = await response.json();

    this.ambientLightData = {
      globalFactor: jsonData.ambient.globalFactor,
      diffuseFactor: jsonData.ambient.diffuseFactor,
      reflectionFactor: jsonData.ambient.reflectionFactor,
      irradianceCubemap: await Cubemap.getAsync(jsonData.ambient.irradianceCubemap),
    };

    this.skyboxTexture = await HDRTexture.getAsync(jsonData.skybox);
    this.ssrEnvironmentTexture = await Cubemap.getAsync(jsonData.ssrEnvironment);

    // Inicializar generador de irradiance
    this.irradianceGenerator = new IrradianceGenerator();
    await this.irradianceGenerator.initialize();

    return true;
  }

  public async update(dt: number): Promise<void> {
    if (this.blendState) {
      this.blendState.blendedWeight = Math.min(
        this.blendState.blendedWeight + dt / this.blendState.blendTime,
        1.0,
      );
      const ratio = this.blendState.interpolator.blend(0, 1, this.blendState.blendedWeight);

      // Blend de cada parámetro
      this.ambientLightData = {
        globalFactor:
          this.blendState.startData.globalFactor * (1.0 - ratio) +
          this.blendState.targetData.globalFactor * ratio,
        diffuseFactor:
          this.blendState.startData.diffuseFactor * (1.0 - ratio) +
          this.blendState.targetData.diffuseFactor * ratio,
        reflectionFactor:
          this.blendState.startData.reflectionFactor * (1.0 - ratio) +
          this.blendState.targetData.reflectionFactor * ratio,
        irradianceCubemap: this.blendState.startData.irradianceCubemap,
      };

      if (this.blendState.blendedWeight >= 1.0) {
        this.blendState = null;
      }
    }

    if (Engine.getInput().isKeyJustPressed(KeyCode.F8)) {
      // ⏸️ Pausar el render loop principal para facilitar debugging
      const moduleRender = Engine.getRender();
      (moduleRender as any).pauseRendering = true;

      for (const comp of Engine.getEntities()
        .getObjectManagerByName('reflection_probe')
        ?.getList() ?? []) {
        const probe = comp as ReflectionProbeComponent;
        await this.captureAndDownloadProbe(probe);
      }

      // ▶️ Reanudar el render loop principal
      (moduleRender as any).pauseRendering = false;
    }
  }

  /**
   * Captura un cubemap desde la posición del probe y lo descarga
   */
  private async captureAndDownloadProbe(probe: ReflectionProbeComponent): Promise<void> {
    const probeName = probe.getOwner().getName();
    const position = probe.getPosition();
    const resolution = probe.getResolution();
    const camera = probe.getCaptureCamera();

    if (!camera) {
      console.error(`❌ Probe ${probeName} no tiene cámara de captura`);
      return;
    }

    const device = GPUUtils.getDevice();

    // ✅ IMPORTANTE: Sobrescribir dimensiones del render ANTES de crear el DeferredRenderer
    // para que todos los recursos (depth, G-Buffer, etc.) se creen con la resolución correcta
    Render.setTemporaryRenderSize(resolution, resolution);

    // Crear DeferredRenderer temporal para renderizar las 6 caras
    const tempRenderer = new DeferredRenderer();
    await tempRenderer.load();
    tempRenderer.create(resolution, resolution);

    // Crear textura cubemap para almacenar resultado final
    const cubemapTexture = device.createTexture({
      label: `${probeName}_cubemap`,
      size: [resolution, resolution, 6],
      format: 'rgba16float',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST | // Necesario para recibir copias
        GPUTextureUsage.TEXTURE_BINDING,
      dimension: '2d',
    });

    // Direcciones y ups para cada cara del cubemap
    const faceDirections: [vec3, vec3][] = [
      [vec3.fromValues(1, 0, 0), vec3.fromValues(0, -1, 0)], // +X
      [vec3.fromValues(-1, 0, 0), vec3.fromValues(0, -1, 0)], // -X
      [vec3.fromValues(0, 1, 0), vec3.fromValues(0, 0, 1)], // +Y
      [vec3.fromValues(0, -1, 0), vec3.fromValues(0, 0, -1)], // -Y
      [vec3.fromValues(0, 0, 1), vec3.fromValues(0, -1, 0)], // +Z
      [vec3.fromValues(0, 0, -1), vec3.fromValues(0, -1, 0)], // -Z
    ];

    // Crear entidad temporal con la cámara del probe
    const tempCameraEntity = new Entity();
    const tempCameraComponent = new CameraComponent();
    tempCameraComponent.setOwner(tempCameraEntity);
    tempCameraComponent.setCamera(camera);
    tempCameraEntity.addComponent('camera', tempCameraComponent);

    // Renderizar cada cara
    for (let face = 0; face < 6; face++) {
      const [direction, up] = faceDirections[face]!;
      const target = vec3.add(vec3.create(), position, direction);

      // Configurar cámara para esta cara
      camera.lookAt(position, target, up);
      camera.updateUniforms();

      // ✅ Actualizar viewport de la cámara a la resolución del probe
      camera.setViewport(resolution, resolution);

      // ✅ INICIAR NUEVO FRAME para el probe (encoder independiente)
      Render.Render.getInstance().beginFrame('Reflection Probe Capture');
      // ✅ CRÍTICO: Configurar la cámara del probe como cámara principal temporal
      // Esto hace que AmbientLight, DirectionalLight y otras luces usen esta cámara
      // en lugar de la cámara principal de la escena
      const moduleRender = Engine.getRender() as any;
      moduleRender.setTemporaryMainCamera(camera);

      // ✅ Configurar RenderManager con la cámara del probe DESPUÉS de beginFrame
      // IMPORTANTE: Esto debe ir ANTES de generateShadowMaps porque las sombras
      // necesitan saber qué cámara está activa
      RenderManager.getInstance().setCamera(camera);
      RenderManager.getInstance().performCulling(camera);

      // ⚠️ DESACTIVADO: generateShadowMaps() sobrescribe el culling de la probe camera
      // Las reflection probes no necesitan shadows detallados
      // tempRenderer.generateShadowMaps();

      // 🔧 CRITICAL FIX: Llamar update() antes de render() para escribir uniforms
      // Sin esto, el ambient uniform buffer queda vacío/corrupto
      tempRenderer.update(0);

      // ✅ Renderizar usando el pipeline completo (G-Buffer + Lighting + Skybox)
      // Con skipPostProcessing = true para evitar SSR y volumetrics (innecesarios en probes)
      tempRenderer.render(tempCameraEntity, true);

      // ✅ Finalizar frame del probe
      Render.Render.getInstance().endFrame();

      // ✅ Copiar resultado del rtAccLight al cubemap
      const encoder = device.createCommandEncoder({
        label: `Reflection Probe ${probeName} Face ${face} Copy`,
      });

      const accLightRenderTarget = tempRenderer.getAccLightRenderTarget();
      const accLightTexture = accLightRenderTarget.getTexture();

      encoder.copyTextureToTexture(
        { texture: accLightTexture },
        { texture: cubemapTexture, origin: { x: 0, y: 0, z: face } },
        { width: resolution, height: resolution, depthOrArrayLayers: 1 },
      );

      device.queue.submit([encoder.finish()]);
    }

    // ✅ IMPORTANTE: Restaurar la cámara principal original
    const moduleRender = Engine.getRender() as any;
    moduleRender.restoreMainCamera();

    // Limpiar renderer temporal
    tempRenderer.destroy();

    // ✅ Restaurar dimensiones originales del render
    Render.Render.restoreRenderSize();

    // ✅ Generar irradiance cubemap a partir del reflection cubemap
    await this.generateAndDownloadIrradiance(cubemapTexture, probeName, resolution);

    // Descargar cubemap de reflection generado
    await this.downloadCubemap(cubemapTexture, probeName, resolution);

    // Limpiar
    cubemapTexture.destroy();
  }

  /**
   * Genera un irradiance cubemap a partir del reflection cubemap y lo descarga
   */
  private async generateAndDownloadIrradiance(
    reflectionTexture: GPUTexture,
    probeName: string,
    resolution: number,
  ): Promise<void> {
    if (!this.irradianceGenerator) {
      console.error('❌ IrradianceGenerator no está inicializado');
      return;
    }

    console.log(`🔶 Generando irradiance para ${probeName}...`);

    // Crear un Cubemap temporal a partir de la textura de reflection
    const tempReflectionCubemap = this.createCubemapFromTexture(
      reflectionTexture,
      `${probeName}_reflection_temp`,
    );

    // Generar irradiance
    const irradianceCubemap =
      await this.irradianceGenerator.generateIrradiance(tempReflectionCubemap);

    // Descargar el irradiance cubemap (128x128)
    const irradianceTexture = (irradianceCubemap as any).gpuTexture as GPUTexture;
    await this.downloadCubemap(irradianceTexture, `${probeName}_irradiance`, 128);

    console.log(`✅ Irradiance generado y descargado para ${probeName}`);
  }

  /**
   * Crea un objeto Cubemap temporal a partir de una GPUTexture
   */
  private createCubemapFromTexture(texture: GPUTexture, name: string): Cubemap {
    const device = GPUUtils.getDevice();

    const cubemap = new Cubemap({
      path: name,
      type: ResourceType.CUBEMAP,
      label: name,
    });

    // Inyectar la textura directamente
    (cubemap as any).gpuTexture = texture;
    (cubemap as any).gpuTextureView = texture.createView({
      dimension: 'cube',
    });
    (cubemap as any).gpuSampler = device.createSampler({
      label: `${name}_sampler`,
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });

    (cubemap as any)._hasData = true;

    return cubemap;
  }

  /**
   * Descarga un cubemap como una sola imagen en formato T horizontal
   * Layout:      [top]
   *         [left][front][right][back]
   *              [bottom]
   */
  private async downloadCubemap(
    texture: GPUTexture,
    name: string,
    resolution: number,
  ): Promise<void> {
    const device = GPUUtils.getDevice();
    const bytesPerPixel = 8; // rgba16float = 8 bytes per pixel
    const bytesPerRow = resolution * bytesPerPixel;
    const bufferSize = bytesPerRow * resolution;

    // Orden de caras en el cubemap: [right, left, top, bottom, front, back]
    const faceNames = ['right', 'left', 'top', 'bottom', 'front', 'back'];

    // Crear canvas grande para el layout en T horizontal (4 ancho x 3 alto)
    const canvasWidth = resolution * 4;
    const canvasHeight = resolution * 3;
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d')!;

    // Posiciones de cada cara en el layout T horizontal
    // [top] está en (1, 0)
    // [left][front][right][back] están en (0,1), (1,1), (2,1), (3,1)
    // [bottom] está en (1, 2)
    const facePositions: Record<string, [number, number]> = {
      top: [1, 0],
      left: [0, 1],
      front: [1, 1],
      right: [2, 1],
      back: [3, 1],
      bottom: [1, 2],
    };

    // Procesar cada cara
    for (let face = 0; face < 6; face++) {
      const faceName = faceNames[face]!;

      // Crear buffer para copiar datos
      const readBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      // Copiar cara del cubemap al buffer
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        {
          texture,
          origin: { x: 0, y: 0, z: face },
        },
        {
          buffer: readBuffer,
          bytesPerRow,
        },
        {
          width: resolution,
          height: resolution,
          depthOrArrayLayers: 1,
        },
      );
      device.queue.submit([encoder.finish()]);

      // Leer datos del buffer
      await readBuffer.mapAsync(GPUMapMode.READ);
      const arrayBuffer = readBuffer.getMappedRange();
      const float16Data = new Uint16Array(arrayBuffer);

      // Convertir Float16 a RGB8 para PNG
      const rgbaData = new Uint8ClampedArray(resolution * resolution * 4);
      let minVal = Infinity;
      let maxVal = -Infinity;
      let avgVal = 0;

      // ✅ CRÍTICO: Invertir Y durante la conversión porque WebGPU tiene Y invertido
      for (let y = 0; y < resolution; y++) {
        for (let x = 0; x < resolution; x++) {
          // Leer desde la posición original (Y normal)
          const srcIndex = (y * resolution + x) * 4;

          // Escribir a la posición invertida (Y invertido)
          const dstY = resolution - 1 - y;
          const dstIndex = (dstY * resolution + x) * 4;

          // Convertir float16 a float32 y luego a 0-255
          const r = this.float16ToFloat32(float16Data[srcIndex + 0]!);
          const g = this.float16ToFloat32(float16Data[srcIndex + 1]!);
          const b = this.float16ToFloat32(float16Data[srcIndex + 2]!);

          // Track min/max para debugging
          const avg = (r + g + b) / 3;
          minVal = Math.min(minVal, avg);
          maxVal = Math.max(maxVal, avg);
          avgVal += avg;

          rgbaData[dstIndex + 0] = Math.min(255, Math.max(0, r * 255));
          rgbaData[dstIndex + 1] = Math.min(255, Math.max(0, g * 255));
          rgbaData[dstIndex + 2] = Math.min(255, Math.max(0, b * 255));
          rgbaData[dstIndex + 3] = 255; // Alpha
        }
      }

      avgVal /= resolution * resolution;

      readBuffer.unmap();
      readBuffer.destroy();

      // Crear ImageData y dibujar en la posición correspondiente del canvas grande
      const imageData = new ImageData(rgbaData, resolution, resolution);
      const [gridX, gridY] = facePositions[faceName]!;
      const canvasX = gridX * resolution;
      const canvasY = gridY * resolution;

      ctx.putImageData(imageData, canvasX, canvasY);
    }

    // Descargar la imagen completa en formato T
    await new Promise<void>((resolve) => {
      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `${name}_cubemap_T.png`;

          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);

          setTimeout(() => URL.revokeObjectURL(url), 100);
        } else {
        }
        resolve();
      });
    });
  }

  /**
   * Convierte float16 a float32 (simplificado)
   */
  private float16ToFloat32(h: number): number {
    const sign = (h & 0x8000) >> 15;
    const exponent = (h & 0x7c00) >> 10;
    const fraction = h & 0x03ff;

    if (exponent === 0) {
      return (sign ? -1 : 1) * Math.pow(2, -14) * (fraction / 1024);
    } else if (exponent === 0x1f) {
      return fraction ? NaN : (sign ? -1 : 1) * Infinity;
    }

    return (sign ? -1 : 1) * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
  }

  public blendTo(
    targetData: AmbientEnvironmentData,
    blendTime: number,
    interpolator: Interpolator,
  ) {
    this.blendState = {
      startData: { ...this.ambientLightData },
      targetData,
      blendTime,
      blendedWeight: 0.0,
      interpolator,
    };
  }

  public changeIrradianceTexture(newTexture: string): void {
    Cubemap.getAsync(newTexture).then((cubemap) => {
      this.ambientLightData.irradianceCubemap = cubemap;
      Engine.getRender().getDeferredRenderer().resetAmbientLightResources();
    });
  }

  public changeSSREnvironmentTexture(newTexture: string): void {
    Cubemap.getAsync(newTexture).then((cubemap) => {
      this.ssrEnvironmentTexture = cubemap;
      Engine.getRender().getDeferredRenderer().resetSSRResources();
    });
  }

  public renderDebug(): void {}

  public stop(): void {}

  public getAmbientLightData(): AmbientEnvironmentData {
    return this.ambientLightData;
  }

  public getSkyboxTexture(): HDRTexture {
    return this.skyboxTexture;
  }

  public getSSREnvironmentTexture(): Cubemap {
    return this.ssrEnvironmentTexture;
  }
}
