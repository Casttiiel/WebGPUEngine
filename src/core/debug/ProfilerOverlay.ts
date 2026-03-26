import { CPUProfiler } from './CPUProfiler';
import { GPUProfiler } from './GPUProfiler';

const OVERLAY_ID = 'profiler-overlay';

const CPU_SCOPES = ['Entities', 'Shadows', 'Deferred', 'Post-Process'] as const;

// Grouped GPU passes — order matches render pipeline execution order
const GPU_GROUPS: { label: string; color: string; passes: string[] }[] = [
  {
    label: 'Geometry',
    color: '#89dceb',
    passes: ['Depth Prepass', 'G-Buffer Pass', 'Decal Pass'],
  },
  {
    label: 'Shadows',
    color: '#f38ba8',
    passes: [
      'Directional Shadow 0',
      'Directional Shadow 1',
      'Directional Shadow 2',
      'Point Shadow',
      'Spot Shadow',
    ],
  },
  {
    label: 'Lighting',
    color: '#fab387',
    passes: [
      'Directional Light',
      'Point Lights Render Pass',
      'Point Lights with Shadows',
      'Spot Lights Render Pass',
      'Spot Lights with Shadows',
      'Ambient Diffuse',
      'Ambient Specular',
      'Skybox',
    ],
  },
  {
    label: 'Transparency',
    color: '#a6e3a1',
    passes: ['Transparent Pass', 'OIT Gather Pass', 'OIT Compose Pass'],
  },
  {
    label: 'Compute FX',
    color: '#cba6f7',
    passes: [
      'GTAO Compute',
      'AO Bilateral Filter Compute',
      'SSR Compute',
      'SSR Blur',
      'SSGI',
      'hzb_build_copy',
      'AE Luminance',
      'AE Adapt',
    ],
  },
  {
    label: 'Volumetrics',
    color: '#89b4fa',
    passes: [
      'froxel_density_compute',
      'froxel_directional_light_injection_compute',
      'froxel_point_light_injection_compute',
      'froxel_spot_light_injection_compute',
      'froxel_volumetrict_integration_compute',
      'froxel_volumetrics_render',
    ],
  },
  {
    label: 'Post-Process',
    color: '#f9e2af',
    passes: [
      'Tone Mapping',
      'Contact Shadows',
      'Height Fog',
      'AO Pass',
      'AO Bilateral Filter',
      'SSGI Bilateral Filter',
      'Bloom',
      'Bloom Combine Pass',
      'Motion Blur',
      'FSR EASU',
      'FSR RCAS',
      'FXAA',
      'SMAA Edge Detection',
      'SMAA Blending Weights',
      'SMAA Neighborhood Blending',
      'SMAA-T2x Edge Detection',
      'SMAA T2x Blending Weights',
      'SMAA T2x Neighborhood Blending',
      'SMAA T2x Temporal Resolve',
      'Palette Quantize',
      'Speed Lines',
      'DOF Pass',
    ],
  },
];

// Flat list for the snapshot loop
const GPU_PASSES = GPU_GROUPS.flatMap((g) => g.passes) as readonly string[];

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
    const frameMs = 1000 / 60; // 16.67 ms budget reference
    const SEP = `<span style="color:#313244">${'─'.repeat(36)}</span>\n`;

    // ── Totals ────────────────────────────────────────────────────────────────
    const cpuTotal = CPU_SCOPES.reduce((s, k) => s + (ProfilerOverlay.cpuMs[k] ?? 0), 0);
    const gpuTotal = GPU_PASSES.reduce((s, k) => s + (ProfilerOverlay.gpuMs[k] ?? 0), 0);

    let html = `<b style="color:#cba6f7">PROFILER</b>  <span style="color:#6c7086;font-size:10px">[F3 to hide]</span>\n`;
    html += SEP;

    // Summary row
    html += `<b style="color:#89b4fa">CPU</b> ${ProfilerOverlay.bar(cpuTotal, frameMs)} <b>${ProfilerOverlay.fmt(cpuTotal)} ms</b>`;
    if (gpuSupported) {
      html += `   <b style="color:#fab387">GPU</b> ${ProfilerOverlay.bar(gpuTotal, frameMs)} <b>${ProfilerOverlay.fmt(gpuTotal)} ms</b>`;
    }
    html += '\n' + SEP;

    // ── CPU breakdown ─────────────────────────────────────────────────────────
    html += `<span style="color:#89b4fa">▸ CPU breakdown</span>\n`;
    for (const s of CPU_SCOPES) {
      const ms = ProfilerOverlay.cpuMs[s] ?? 0;
      html += `  ${ProfilerOverlay.bar(ms, frameMs)} <b>${s}</b>  ${ProfilerOverlay.fmt(ms)} ms\n`;
    }
    html += SEP;

    // ── GPU breakdown ─────────────────────────────────────────────────────────
    if (!gpuSupported) {
      html += `<span style="color:#fab387">▸ GPU</span>  <span style="color:#6c7086">timestamp-query not available</span>\n`;
      return html;
    }

    for (const group of GPU_GROUPS) {
      // Only show groups that have at least one active pass
      const activePasses = group.passes.filter((p) => (ProfilerOverlay.gpuMs[p] ?? 0) > 0);
      if (activePasses.length === 0) continue;

      const groupTotal = activePasses.reduce((s, p) => s + (ProfilerOverlay.gpuMs[p] ?? 0), 0);

      html += `<span style="color:${group.color}">▸ ${group.label}</span>`;
      html += `  <span style="color:#6c7086">${ProfilerOverlay.fmt(groupTotal)} ms</span>\n`;

      for (const p of activePasses) {
        const ms = ProfilerOverlay.gpuMs[p] ?? 0;
        // Short name: strip common verbose suffixes for tighter display
        const short = p
          .replace(' Render Pass', '')
          .replace(' Compute', '')
          .replace('froxel_', '')
          .replace('_compute', '')
          .replace('_injection', ' inj')
          .replace('_light', ' light')
          .replace('hzb_build_copy', 'HZB Build')
          .replace('froxel_volumetrict_integration_compute', 'vol. integration');
        html += `  ${ProfilerOverlay.bar(ms, frameMs)} <span style="color:#cdd6f4">${short}</span>  ${ProfilerOverlay.fmt(ms)} ms\n`;
      }
    }

    return html;
  }
}
