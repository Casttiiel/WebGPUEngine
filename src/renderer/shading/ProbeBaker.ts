import { vec3 } from 'gl-matrix';
import { Engine } from '../../core/engine/Engine';
import { Entity } from '../../core/ecs/Entity';
import { CameraComponent } from '../../components/render/CameraComponent';
import { DirectionalLightComponent } from '../../components/render/DirectionalLightComponent';
import type { ReflectionProbeComponent } from '../../components/render/ReflectionProbeComponent';
import { RenderManagerV2 as RenderManager } from '../core/managers/RenderManagerV2';
import { ProbeFaces, ProbeManager } from '../core/managers/ProbeManager';
import { DeferredRenderer } from '../core/pipeline/DeferredRenderer';
import { Render } from '../core/pipeline/Render';
import { GPUUtils } from '../core/utils/GPUUtils';
import { SHProjector } from '../core/SHProjector';
import { encodeProbeFaces } from '../resources/ProbeFile';

interface ProbeCapture {
  faces: ProbeFaces;
  sh: Float32Array;
}

// Cube faces in WebGPU order (+X −X +Y −Y +Z −Z): view direction and camera up. With this
// engine's projection the captured texels land in the cube convention SHProjector and the
// prefilter use (verified: sky in +Y, panorama continuous across faces).
const FACES: ReadonlyArray<[vec3, vec3]> = [
  [vec3.fromValues(1, 0, 0), vec3.fromValues(0, -1, 0)],
  [vec3.fromValues(-1, 0, 0), vec3.fromValues(0, -1, 0)],
  [vec3.fromValues(0, 1, 0), vec3.fromValues(0, 0, 1)],
  [vec3.fromValues(0, -1, 0), vec3.fromValues(0, 0, -1)],
  [vec3.fromValues(0, 0, 1), vec3.fromValues(0, -1, 0)],
  [vec3.fromValues(0, 0, -1), vec3.fromValues(0, -1, 0)],
];

/**
 * Bakes every ReflectionProbeComponent of the scene (F8):
 *   bounce 1 — probes hidden: the sky (environment SH + cubemap) lights the capture
 *   bounce 2 — the bounce-1 probes light it, so light bounces off walls and floor twice
 * Only static geometry is drawn (RenderManager.staticOnly). Results go live immediately and
 * are saved to public/assets/probes/ through the dev server ({name}_sh.json, {name}_env.bin).
 */
export class ProbeBaker {
  public static async bakeAll(bounces = 2): Promise<void> {
    const manager = ProbeManager.getInstance();
    const probes = [...manager.getProbes()];
    if (probes.length === 0) {
      console.warn('[ProbeBaker] No reflection probes in the scene (F7 places them).');
      return;
    }
    const render = Engine.getRender();
    render.pauseRendering = true;
    const t0 = performance.now();
    try {
      for (let bounce = 1; bounce <= bounces; bounce++) {
        manager.setBakingMode(bounce === 1);
        const captures: ProbeCapture[] = [];
        for (const probe of probes) captures.push(await ProbeBaker.capture(probe));
        manager.setBakingMode(false);
        for (let i = 0; i < probes.length; i++) {
          probes[i]!.setSH(captures[i]!.sh);
          await manager.setProbeEnv(probes[i]!, captures[i]!.faces);
        }
        console.log(`[ProbeBaker] bounce ${bounce}/${bounces}: ${probes.length} probes`);
        if (bounce === bounces) {
          for (let i = 0; i < probes.length; i++) {
            const name = probes[i]!.getOwner().getName();
            await ProbeBaker.save('probes', `${name}_sh.json`, JSON.stringify({ sh: Array.from(captures[i]!.sh) }));
            await ProbeBaker.save('probes', `${name}_env.bin`, encodeProbeFaces(captures[i]!.faces));
          }
        }
      }
      console.log(`[ProbeBaker] done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    } finally {
      manager.setBakingMode(false);
      render.pauseRendering = false;
    }
  }

  /** Renders the 6 faces from the probe's position (static scene, full lighting, no post). */
  public static async capture(probe: ReflectionProbeComponent): Promise<ProbeCapture> {
    const position = probe.getPosition();
    const size = probe.getResolution();
    const camera = probe.getCaptureCamera()!;
    const device = GPUUtils.getDevice();
    const render = Engine.getRender();
    const renderManager = RenderManager.getInstance();

    // Render targets of the temporary renderer are created at the probe's resolution.
    Render.setTemporaryRenderSize(size, size);
    const renderer = new DeferredRenderer(false);
    await renderer.load();
    renderer.create(size, size);

    const cube = device.createTexture({
      label: 'probe_capture_faces',
      size: [size, size, 6],
      format: 'rgba16float',
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });

    const cameraEntity = new Entity();
    const cameraComponent = new CameraComponent();
    cameraComponent.setOwner(cameraEntity);
    cameraComponent.setCamera(camera);
    cameraEntity.addComponent('camera', cameraComponent);

    renderManager.staticOnly = true;
    try {
      for (let face = 0; face < 6; face++) {
        const [dir, up] = FACES[face]!;
        camera.lookAt(position, vec3.add(vec3.create(), position, dir), up);
        camera.setViewport(size, size);
        camera.updateUniforms(0);

        Render.getInstance().beginFrame();
        // Lights, ambient and probes read the main camera: make it the probe's.
        render.setTemporaryMainCamera(camera);
        renderManager.setCamera(camera);
        renderManager.performCulling(camera);
        for (const light of Engine.getEntities().getObjectManagerByName('directional_light')?.getList() ?? []) {
          (light as DirectionalLightComponent).updateShadowsForCamera(camera);
        }
        renderer.generateShadowMaps();
        renderManager.setCamera(camera);
        renderManager.performCulling(camera);
        renderer.update(0);
        renderer.render(cameraEntity, true);
        Render.getInstance().endFrame();

        const encoder = device.createCommandEncoder({ label: `probe_capture_face_${face}` });
        encoder.copyTextureToTexture(
          { texture: renderer.getAccLightRenderTarget().getTexture() },
          { texture: cube, origin: { x: 0, y: 0, z: face } },
          [size, size, 1],
        );
        device.queue.submit([encoder.finish()]);
      }
    } finally {
      renderManager.staticOnly = false;
      render.restoreMainCamera();
      renderer.destroy();
      Render.restoreRenderSize();
    }

    const faces = await ProbeBaker.readFaces(cube, size);
    const sh = await SHProjector.projectFromGPUTexture(cube, size);
    cube.destroy();
    return { faces, sh };
  }

  private static async readFaces(texture: GPUTexture, size: number): Promise<ProbeFaces> {
    const device = GPUUtils.getDevice();
    const bytesPerRow = size * 8; // multiple of 256 for size ≥ 32
    const buffer = device.createBuffer({
      size: bytesPerRow * size * 6,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder({ label: 'probe_capture_readback' });
    encoder.copyTextureToBuffer(
      { texture },
      { buffer, bytesPerRow, rowsPerImage: size },
      [size, size, 6],
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const data = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    return { size, data };
  }

  /**
   * Writes public/assets/{folder}/{file} through the dev server (vite.config.ts,
   * /__bake/save). Without it (production build) the file is downloaded instead.
   */
  public static async save(folder: 'probes' | 'scenes', file: string, body: ArrayBuffer | string): Promise<void> {
    try {
      const response = await fetch(
        `${import.meta.env.BASE_URL}__bake/save?folder=${folder}&file=${encodeURIComponent(file)}`,
        { method: 'POST', body },
      );
      if (response.ok) return;
    } catch {
      // no dev server
    }
    const url = URL.createObjectURL(new Blob([body]));
    const link = document.createElement('a');
    link.href = url;
    link.download = file;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    console.warn(`[ProbeBaker] ${file} downloaded: copy it to public/assets/${folder}/`);
  }
}
