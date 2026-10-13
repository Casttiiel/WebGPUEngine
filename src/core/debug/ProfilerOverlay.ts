import { CPUProfiler } from './CPUProfiler';
import { GPUProfiler } from './GPUProfiler';

const OVERLAY_ID = 'profiler-overlay';

const CPU_SCOPES = ['Entities', 'Shadows', 'Deferred', 'Post-Process'] as const;

// Grouped GPU passes — order matches render pipeline execution order.
// Any measured pass not listed here is still shown, under "Other".
const GPU_GROUPS: { label: string; color: string; passes: string[] }[] = [
  {
    label: 'Geometry',
    color: '#89dceb',
    passes: ['hzb_build_copy', 'Depth Prepass', 'G-Buffer Pass', 'Decal Pass'],
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
    label: 'Screen-space (AO / SSR / contact)',
    color: '#cba6f7',
    passes: [
      'GTAO Compute',
      'SSAO Compute',
      'AO Blur Horizontal',
      'AO Blur Vertical',
      'Contact Shadows',
      'SSR Trace',
      'SSR Temporal',
      'SSR Denoise',
    ],
  },
  {
    label: 'Lighting',
    color: '#fab387',
    passes: [
      'Tiled Light Cull',
      'Ambient Diffuse',
      'Directional Light',
      'Area Light',
      'Point Lights Render Pass',
      'Point Lights with Shadows',
      'Spot Lights Render Pass',
      'Spot Lights with Shadows',
      'Ambient Specular',
      'Skybox',
      'VolumetricClouds',
      'VolumetricClouds Temporal',
      'VolumetricClouds Composite',
    ],
  },
  {
    label: 'Volumetrics',
    color: '#89b4fa',
    passes: [
      'froxel_density_compute',
      'froxel_self_occlusion_compute',
      'froxel_directional_light_injection_compute',
      'froxel_point_light_injection_compute',
      'froxel_spot_light_injection_compute',
      'froxel_volumetrict_integration_compute',
      'froxel_volumetrics_render',
    ],
  },
  {
    label: 'Transparency',
    color: '#a6e3a1',
    passes: ['Transparent Pass', 'OIT Gather Pass', 'OIT Compose Pass'],
  },
  {
    label: 'Post-Process',
    color: '#f9e2af',
    passes: [
      'Velocity Buffer',
      'Velocity Per-Object',
      'Velocity Skinned',
      'Height Fog',
      'Bloom',
      'Bloom Combine Pass',
      'Motion Blur',
      'DOF Pass',
      'AE Luminance',
      'AE Adapt',
      'TAA Resolve',
      'TSR Resolve',
      'Tone Mapping',
      'Palette Quantize',
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
      'Speed Lines',
      'UI Overlay',
      'Present',
    ],
  },
];

const KNOWN_GPU_PASSES = new Set(GPU_GROUPS.flatMap((g) => g.passes));

/**
 * Lightweight HTML overlay for real-time CPU + GPU profiling data.
 *
 * Toggle with F1 (always available, independent of editor mode).
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

    // Wire F1 toggle
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F1') {
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
    // Every pass measured last frame (known groups + anything new, shown under "Other")
    ProfilerOverlay.gpuMs = Object.fromEntries(gpu.getAllResults());

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
    const gpuTotal = Object.values(ProfilerOverlay.gpuMs).reduce((s, v) => s + v, 0);

    let html = `<b style="color:#cba6f7">PROFILER</b>  <span style="color:#6c7086;font-size:10px">[F1 to hide]</span>\n`;
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

    const otherPasses = Object.keys(ProfilerOverlay.gpuMs).filter((p) => !KNOWN_GPU_PASSES.has(p));
    const groups = otherPasses.length > 0
      ? [...GPU_GROUPS, { label: 'Other', color: '#a6adc8', passes: otherPasses }]
      : GPU_GROUPS;

    for (const group of groups) {
      // Show every pass that ran (present in the results), even if it averages ~0 ms
      const activePasses = group.passes.filter((p) => ProfilerOverlay.gpuMs[p] !== undefined);
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
