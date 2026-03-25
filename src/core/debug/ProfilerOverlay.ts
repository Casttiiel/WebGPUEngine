import { CPUProfiler } from './CPUProfiler';
import { GPUProfiler } from './GPUProfiler';

const OVERLAY_ID = 'profiler-overlay';

const CPU_SCOPES = ['Entities', 'Shadows', 'Deferred', 'Post-Process'] as const;

const GPU_PASSES = [
  // ── Shadows ────────────────────────────────────────────
  'Directional Shadow',
  'Point Shadow',
  'Spot Shadow',
  // ── Lighting ───────────────────────────────────────────
  'Directional Light',
  'Ambient Diffuse',
  'Ambient Specular',
  'Skybox',
  // ── G-Buffer & Geometry ────────────────────────────────
  'Depth Prepass',
  'G-Buffer Pass',
  'Decal Pass',
  'Transparent Pass',
  'OIT Gather Pass',
  'OIT Compose Pass',
  // ── Lights (deferred) ──────────────────────────────────
  'Point Lights Render Pass',
  'Point Lights with Shadows',
  'Spot Lights Render Pass',
  'Spot Lights with Shadows',
  // ── Compute effects ────────────────────────────────────
  'GTAO Compute',
  'AO Bilateral Filter Compute',
  'SSR Compute',
  'SSR Blur',
  'SSGI',
  'hzb_build_copy',
  // ── Auto Exposure ──────────────────────────────────────
  'AE Luminance',
  'AE Adapt',
  // ── Volumetrics ────────────────────────────────────────
  'froxel_density_compute',
  'froxel_directional_light_injection_compute',
  'froxel_point_light_injection_compute',
  'froxel_spot_light_injection_compute',
  'froxel_volumetrict_integration_compute',
  'froxel_volumetrics_render',
  // ── Post Process ───────────────────────────────────────
  'Post Process Pass',
  'Bloom Combine Pass',
  'DOF Pass',
] as const;

/**
 * Lightweight HTML overlay for real-time CPU + GPU profiling data.
 *
 * Toggle with F3 (always available, independent of editor mode).
 * Updates every ~200 ms to keep the display readable.
 */
export class ProfilerOverlay {
  private static visible = false;
  private static el: HTMLElement | null = null;
  private static accumDt = 0;
  private static readonly UPDATE_INTERVAL = 0.2; // seconds

  // Snapshot values updated at each refresh
  private static cpuMs: Record<string, number> = {};
  private static gpuMs: Record<string, number> = {};

  // ─── Public API ─────────────────────────────────────────────────────────────

  public static initialize(): void {
    ProfilerOverlay.el = document.getElementById(OVERLAY_ID);
    if (!ProfilerOverlay.el) return;

    // Wire F3 toggle
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F3') {
        e.preventDefault();
        ProfilerOverlay.toggle();
      }
    });
  }

  public static toggle(): void {
    ProfilerOverlay.visible = !ProfilerOverlay.visible;
    if (ProfilerOverlay.el) {
      ProfilerOverlay.el.style.display = ProfilerOverlay.visible ? 'block' : 'none';
    }
  }

  /** Call every frame from the main loop (alongside Time.updateFPSDisplay). */
  public static update(dt: number, cpu: CPUProfiler): void {
    if (!ProfilerOverlay.visible || !ProfilerOverlay.el) return;

    ProfilerOverlay.accumDt += dt;
    if (ProfilerOverlay.accumDt < ProfilerOverlay.UPDATE_INTERVAL) return;
    ProfilerOverlay.accumDt = 0;

    const gpu = GPUProfiler.getInstance();

    // Capture snapshot
    for (const s of CPU_SCOPES) {
      ProfilerOverlay.cpuMs[s] = cpu.getMs(s);
    }
    for (const p of GPU_PASSES) {
      ProfilerOverlay.gpuMs[p] = gpu.getMs(p);
    }

    ProfilerOverlay.el.innerHTML = ProfilerOverlay.buildHTML(gpu.supported);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private static fmt(ms: number): string {
    return ms.toFixed(2);
  }

  private static bar(ms: number, max: number): string {
    const pct = Math.min(1, ms / max);
    const filled = Math.round(pct * 12);
    const color = pct > 0.75 ? '#ff6b6b' : pct > 0.4 ? '#ffa94d' : '#69db7c';
    return `<span style="color:${color}">${'█'.repeat(filled)}${'░'.repeat(12 - filled)}</span>`;
  }

  private static buildHTML(gpuSupported: boolean): string {
    const frameMs = 1000 / 60; // budget reference (16.67 ms)

    let html = `<b style="color:#cba6f7">PROFILER</b>  <span style="color:#6c7086;font-size:11px">[F3 to hide]</span>\n`;
    html += `<span style="color:#6c7086">─────────────────────────────</span>\n`;

    html += `<span style="color:#89b4fa">CPU</span>\n`;
    for (const s of CPU_SCOPES) {
      const ms = ProfilerOverlay.cpuMs[s] ?? 0;
      html += ` ${ProfilerOverlay.bar(ms, frameMs)} <b>${s}</b>  ${ProfilerOverlay.fmt(ms)} ms\n`;
    }

    html += `<span style="color:#6c7086">─────────────────────────────</span>\n`;

    if (!gpuSupported) {
      html += `<span style="color:#fab387">GPU</span>  <span style="color:#6c7086">timestamp-query not available</span>\n`;
    } else {
      html += `<span style="color:#fab387">GPU</span>\n`;
      for (const p of GPU_PASSES) {
        const ms = ProfilerOverlay.gpuMs[p] ?? 0;
        if (ms === 0) continue; // hide unused passes
        html += ` ${ProfilerOverlay.bar(ms, frameMs)} <b>${p}</b>  ${ProfilerOverlay.fmt(ms)} ms\n`;
      }
    }

    return html;
  }
}
