# Screen-Space Radiance Cascades (SSRC)

## Objetivo

Reemplazar SSGI con una técnica de GI difusa jerárquica noise-free. RC organiza el ray tracing en N niveles (cascadas), cada uno a la mitad de resolución, con 4× más direcciones y 4× más rango que el nivel anterior. Las cascadas se propagan de coarser a finer usando interval-complement blending — sin ruido por construcción, sin denoiser necesario.

**Comparación con SSGI actual:**

- SSGI: sampling aleatorio por pixel → ruido → bilateral filter
- RC: direcciones deterministas organizadas en jerarquía → sin ruido, sin denoiser

---

## Posición en el pipeline

```
GBuffer (SOLIDS + DECALS)
→ AO (compute)
→ renderAccLight          ← rtAccLight tiene direct lighting aquí
→ RC Trace (compute)      ← lee rtAccLight como radiance source
→ RC Merge × 3 (compute)  ← propaga de cascade 3 → 0
→ RC Apply (compute)      ← bilateral upsample + albedo multiply
→ RC Composite            ← additive blend gi_result → rtAccLight
→ [SSGI desactivado si RC activo]
→ Water / Transparent / Glass / SSR / Post
```

RC corre **después de `renderAccLight`** porque necesita la luz directa en `rtAccLight` como radiance source. Objetos dinámicos y decals ya están en `rtAccLight` en ese punto.

---

## Estructura de cascadas (2560×1440)

| Cascade | Resolución    | Rays/probe | Intervalo  | Steps | Step size | Temporal blend |
| ------- | ------------- | ---------- | ---------- | ----- | --------- | -------------- |
| 0       | 640×360 (W/4) | 4          | [0, R]     | 32    | R/32      | No             |
| 1       | 320×180 (W/8) | 16         | [R, 4R]    | 24    | 3R/24     | No             |
| 2       | 160×90 (W/16) | 64         | [4R, 16R]  | 16    | 12R/16    | Sí α=0.9       |
| 3       | 80×45 (W/32)  | 256        | [16R, 64R] | 16    | 3R        | Sí α=0.95      |

`R` = `baseRange` (configurable, ~0.5 m world-space por defecto).

### Presupuesto de dispatch (2K)

```
Cascade 0: 640×360 × 4 × 32  ≈  29.5M steps
Cascade 1: 320×180 × 16 × 24 ≈  22.1M steps
Cascade 2: 160×90  × 64 × 16 ≈  14.7M steps
Cascade 3: 80×45   × 256 × 16 ≈  14.7M steps
Merge × 3:                    ≈   negligible
Apply bilateral (3×3):        ≈  33.2M samples
──────────────────────────────────────────────
Total:                        ≈ 114M op/frame
```

Para comparar: SSAO en HIGH ≈ 190M. RC es más barato. Si benchmark muestra >4ms: reducir `rcCascadeCount` de 4 a 3.

---

## Qué almacena cada cascade

**RGBA16F por texel:**

- **RGB** — irradiance media de los rays que golpearon geometría en el intervalo `[start_i, end_i]`. Los rays que no golpean nada NO contribuyen a RGB (excepto en cascade 3 — ver IBL fallback).
- **A** — `hit_fraction` ∈ [0,1] = fracción de los N_i rays que encontraron geometría en el intervalo.

**Excepción cascade 3 (coarsest):** Los rays que salen del frustum o superan `max_distance` samplea el `irradianceCubemap` en la dirección del ray y contribuyen con ese valor a RGB, con `A += 1.0`. Esto ancla la cadena de merge con datos válidos en lugar de negro.

---

## Algoritmo de trace (rc_trace.compute.wgsl)

```wgsl
// Por cada probe (pixel) en cascade i:
for ray_index in 0..num_rays:
    origin = reconstruct_world_pos(uv, linearDepth, camera.invViewProjection)
    dir    = cascade_direction(ray_index, num_rays, probe_id)

    // Ray march en screen-space sobre intervalo [intervalStart, intervalEnd]
    hit = screen_space_march(origin + normal*bias, dir, intervalStart, intervalEnd, maxSteps)

    if hit.found:
        radiance = textureSampleLevel(rtAccLight, sampler, hit.uv, 0.0).rgb
        accum_rgb += radiance
        hit_count++
    elif cascade_index == MAX_CASCADE:
        // IBL fallback solo en la cascada más coarse
        accum_rgb += textureSample(irradianceCubemap, envSampler, dir).rgb
        hit_count++
    // else: ray escapó frustum en cascadas finas → no contribuye (cascade superior lo cubrirá)

output_rgb   = accum_rgb / f32(num_rays)
output_alpha = f32(hit_count) / f32(num_rays)
```

### Direcciones deterministas (Fibonacci + rotación por probe)

```wgsl
// Genera dirección en el hemisferio orientado a la normal del G-Buffer.
// phi ∈ [0, π/2] (semiesfera), no esfera completa.
fn cascade_direction(ray_index: u32, num_rays: u32, probe_id: u32, normal: vec3<f32>) -> vec3<f32> {
    let rotation_offset = f32(probe_id % 8u) * (TWO_PI / 8.0);
    let i     = f32(ray_index);
    let n     = f32(num_rays);
    // Fibonacci en hemisferio: phi ∈ [0, π/2] → cos(phi) ∈ [0, 1]
    let phi   = acos(1.0 - (i + 0.5) / n);   // ← hemisferio, no esfera completa
    let theta = TWO_PI * i * GOLDEN_RATIO + rotation_offset;
    let local_dir = vec3<f32>(sin(phi)*cos(theta), cos(phi), sin(phi)*sin(theta));

    // Transformar al espacio de la normal del surface (TBN)
    return normalize(build_tbn(normal) * local_dir);
}

// Construye matriz TBN a partir de la normal world-space
fn build_tbn(n: vec3<f32>) -> mat3x3<f32> {
    var up = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(n.y) > 0.999) { up = vec3<f32>(1.0, 0.0, 0.0); }
    let t = normalize(cross(up, n));
    let b = cross(n, t);
    return mat3x3<f32>(t, n, b);  // columnas: tangent, normal, bitangent
}
```

La rotación por probe index (módulo 8, sin random) distribuye los artefactos de 4 manchas entre probes vecinos. Sin jitter temporal — determinista puro.

---

## Algoritmo de merge (rc_merge.compute.wgsl)

Ejecutado N-1 veces, de cascade 3 hacia cascade 0 (más alto primero).

```wgsl
// Por cada probe p en cascade i:
let cascade_next_res = vec2<f32>(...);  // resolución de cascade i+1
let half_texel = 0.5 / cascade_next_res;

// UV del probe padre en cascade i+1 (un nivel más coarse)
let parent_uv = (vec2<f32>(probe_id_2d) + 0.5) / cascade_res * 0.5;
// Clamp para evitar bleeding en bordes de atlas
let clamped_uv = clamp(parent_uv, half_texel, vec2(1.0) - half_texel);

let c_fine   = cascade_i[probe_id];              // trace del intervalo cercano
let c_coarse = textureSampleLevel(cascade_next, sampler, clamped_uv, 0.0);

// Interval-complement blending:
// - c_fine.a = fracción cubierta por screen-space cercano
// - (1 - c_fine.a) = fracción no cubierta → hereda del nivel coarser
let open = 1.0 - c_fine.a;
merged.rgb = c_fine.rgb + open * c_coarse.rgb;
merged.a   = clamp(c_fine.a + open * c_coarse.a, 0.0, 1.0);
```

**Por qué no hay discontinuidades:** la transición es proporcional a `hit_fraction`, no espacial. Cuando `c_fine.a = 1.0` (geometría cercana densa), el nivel coarser contribuye 0. Cuando `c_fine.a = 0.0` (espacio abierto), el nivel coarser contribuye totalmente.

---

## Temporal accumulation (cascades 2 y 3)

Ping-pong idéntico a TAA (`historyRT` + `copyTextureToTexture` al final del frame):

```wgsl
// En el trace/merge de cascade 2 y 3:
let traced   = compute_cascade_radiance(probe_id);
let history  = textureLoad(history_cascade, probe_id_2d, 0);
let alpha    = rc_params.temporalBlend;  // 0.9 para c2, 0.95 para c3
output = mix(traced, history, alpha);
// alpha=0 cuando historyInvalid=true (teleport / primer frame)
```

`historyInvalid` se activa desde TypeScript via `invalidateHistory()`. Se consume en el frame siguiente y se resetea.

---

## Apply pass (rc_apply.compute.wgsl)

Depth-aware bilateral upsample de cascade 0 (W/4 × H/4) a full-res + composite de GI:

```wgsl
// Por cada pixel full-res p:
let p_depth          = textureLoad(gLinearDepth, p, 0).r;
let p_normals_sample = textureLoad(gNormals, p, 0);       // cargado una sola vez
let p_normal         = decode_normal(p_normals_sample.xy);
let roughness        = p_normals_sample.b;
let p_albedo         = textureLoad(gAlbedo, p, 0);
let metallic         = p_albedo.a;

var weighted_sum   = vec3(0.0);
var weight_total   = 0.0;

// 3×3 neighborhood en cascade 0 (half-res coords)
for dx in -1..1, dy in -1..1:
    let sample_uv    = (vec2<f32>(p) / screen_size) + vec2<f32>(dx, dy) / cascade0_res;
    let sample_depth = textureSampleLevel(gLinearDepth, sampler, sample_uv, 0.0).r;
    let sample_normal = decode_normal(textureSampleLevel(gNormals, sampler, sample_uv, 0.0).xy);
    let sample_rc    = textureSampleLevel(cascade0, sampler, sample_uv, 0.0);

    let w_depth  = exp(-abs(p_depth - sample_depth) * DEPTH_SIGMA);
    let w_normal = exp(-(1.0 - max(dot(p_normal, sample_normal), 0.0)) * NORMAL_SIGMA);
    let w        = w_depth * w_normal;

    weighted_sum  += sample_rc.rgb * w;
    weight_total  += w;

let irradiance = weighted_sum / max(weight_total, 0.0001);

// PBR-consistent diffuse factor
let diffuse_factor = (1.0 - metallic) * (1.0 - roughness * 0.5);
let gi_contribution = irradiance * p_albedo.rgb * diffuse_factor;

// Additive composite sobre rtAccLight (storage texture write)
let existing = textureLoad(rtAccLight, p, 0);
textureStore(rtAccLight, p, existing + vec4(gi_contribution, 0.0));
```

---

## Archivos a crear

### Shaders

| Archivo                                          | Descripción                                            |
| ------------------------------------------------ | ------------------------------------------------------ |
| `public/assets/shaders/rc/rc_trace.compute.wgsl` | Trace por cascade. IBL fallback en cascade más coarse. |
| `public/assets/shaders/rc/rc_merge.compute.wgsl` | Interval-complement blending. Clamp de bordes.         |
| `public/assets/shaders/rc/rc_apply.compute.wgsl` | Bilateral upsample + albedo modulation + composite.    |

### TypeScript

| Archivo                                    | Descripción                                                    |
| ------------------------------------------ | -------------------------------------------------------------- |
| `src/renderer/shading/RadianceCascades.ts` | Clase principal. Owns pipelines, RTs, history, dispatch logic. |

### Modificaciones

| Archivo                                          | Cambio                                                        |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `src/renderer/core/pipeline/DeferredRenderer.ts` | Instanciar RC, llamar tras `renderAccLight`, toggle con SSGI. |
| `src/core/engine/QualitySettings.ts`             | Añadir `enableRC`, `rcCascadeCount: 3\|4`, `rcBaseRange`.     |

---

## GPU resources en RadianceCascades.ts

```typescript
// Cascade render targets (RGBA16F, storage + texture)
private cascadeRT: RenderTarget[];      // [0..3], resolución decrece × 0.5

// History para temporal (solo cascades 2 y 3)
private historyRT: [RenderTarget, RenderTarget];   // [cascade2, cascade3]

// El apply pass escribe directamente a rtAccLight (storage texture).
// No se necesita giResultRT intermedio — se elimina para evitar VRAM innecesaria.

// Pipelines compute (una por pass-type)
private tracePipeline:  GPUComputePipeline;
private mergePipeline:  GPUComputePipeline;
private applyPipeline:  GPUComputePipeline;

// Uniform buffer por cascade dispatch
private rcParamsBuffer: GPUBuffer;      // RCParams struct, updated each dispatch

// Estado temporal
private historyInvalid: boolean = true; // true en primer frame o tras invalidateHistory()
```

---

## Uniform buffer RCParams

```wgsl
struct RCParams {
    cascadeIndex:  f32,   // 0..3
    cascadeCount:  f32,   // 3 o 4
    baseRange:     f32,   // R en world units
    intervalStart: f32,   // R × 4^(i-1), 0 para i=0
    intervalEnd:   f32,   // R × 4^i
    raysPerProbe:  f32,   // 4 × 4^i
    maxSteps:      f32,   // 32/24/16/16
    temporalBlend: f32,   // 0.0 para c0/c1, 0.9/0.95 para c2/c3 (0 si historyInvalid)
    cascadeRes:    vec2<f32>,
    screenSize:    vec2<f32>,
}
```

---

## Bind group layout del trace pass

- **group(0)**: CameraUniforms
- **group(1)**: gAlbedo, gNormals, gLinearDepth, samplerGBuffer _(layout GBuffer compute — ya existe en `BindGroupFactory`)_
- **group(2)**: rtAccLight (texture_2d), irradianceCubemap (texture_cube), envSampler, historyRT (texture_2d, noop para cascades 0/1), RCParams uniform
- **group(3)**: cascadeRT[i] (storage_texture, write)

---

## Invalidación de history

```typescript
// En RadianceCascades.ts:
public invalidateHistory(): void {
    this.historyInvalid = true;
}

// Quién lo llama:
MsgDispatcher.register(MsgType.SCENE_LOAD, 'radiance_cascades', () => {
    this.invalidateHistory();
});
// También llamado desde onResize() (igual que TAA)
```

Cuando `historyInvalid = true`: upload `temporalBlend = 0.0` en RCParams para cascades 2 y 3. Se resetea a `false` al final del mismo frame (después del `copyTextureToTexture` a history).

---

## QualitySettings: campos a añadir

```typescript
interface GraphicsQualitySettings {
  // ...campos existentes...
  enableRC: boolean; // reemplaza enableSSGI cuando true
  rcCascadeCount: 3 | 4; // 3 = presupuesto reducido, 4 = calidad máxima
  rcBaseRange: number; // R en world units, default 0.5
}

// Presets:
// LOW/MEDIUM: enableRC: false
// HIGH:       enableRC: true, rcCascadeCount: 3
// ULTRA:      enableRC: true, rcCascadeCount: 4
```

---

## Fases de implementación

### Fase 1 — Infraestructura (sin shaders)

- Crear `RadianceCascades.ts` con allocación de RTs y buffers
- Añadir `enableRC`, `rcCascadeCount`, `rcBaseRange` a QualitySettings y presets
- Wire en `DeferredRenderer.ts` como no-op stub
- Añadir `MsgType.SCENE_LOAD` si no existe

### Fase 2 — Trace pass

- `rc_trace.compute.wgsl`: reconstrucción world-pos desde depth + camera, Fibonacci directions con rotación por probe, screen-space march, IBL fallback en cascade más coarse
- Dispatch separado por cascade con RCParams actualizado

### Fase 3 — Merge pass

- `rc_merge.compute.wgsl`: interval-complement blending, border clamp, temporal blend para cascades 2/3 con history ping-pong

### Fase 4 — Apply + Composite

- `rc_apply.compute.wgsl`: depth-aware bilateral upsample 3×3, roughness modulation, additive composite sobre rtAccLight

### Fase 5 — Debug + Quality

- Toggle por cascade en debug UI, `rcBaseRange` ajustable en runtime
- Visualización por cascade separada
- Benchmark para validar presupuesto GPU; ajustar `rcCascadeCount` por preset si necesario

---

## Notas de implementación

- **No uses `beginRenderPass`** — RC es 100% compute.
- **Workgroup size**: `@workgroup_size(8, 8, 1)` en los tres shaders. Dispatch = `ceil(cascadeW / 8) × ceil(cascadeH / 8) × 1`.
- **SamplerLibrary**: `environmentCubemap` para IBL fallback, `simpleSampler` para cascade reads en merge/apply.
- **Storage textures en WebGPU**: requieren `GPUTextureUsage.STORAGE_BINDING | TEXTURE_BINDING | COPY_SRC | COPY_DST`.
- **Separar command encoders** entre trace y merge para evitar resource conflicts (mismo patrón que AO y bloom).
- **SSGI toggle**: si `enableRC = true`, saltar el bloque SSGI en `DeferredRenderer.render()`.
- **IBL cubemap access**: `Engine.getEnvironmentManager()...irradianceCubemap.getTextureView()` (preconvolved Lambertian, no el especular).
- **Reconstrucción de world_pos** — usar `camera.invViewProjection` (existe en `CameraUniforms`). Fórmula exacta:

```wgsl
fn reconstruct_world_pos(uv: vec2<f32>, linear_depth: f32, inv_view_proj: mat4x4<f32>,
                          cam_pos: vec3<f32>, cam_far: f32) -> vec3<f32> {
    // NDC desde UV (Y sin flip — WebGPU NDC Y apunta hacia arriba igual que UV)
    let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
    let world_h   = inv_view_proj * ndc;
    let world_dir = normalize(world_h.xyz / world_h.w - cam_pos);
    // linear_depth está en rango [0,1] normalizado por cameraFar (ver G-Buffer)
    return cam_pos + world_dir * (linear_depth * cam_far);
}
// Llamada: reconstruct_world_pos(probe_uv, g.zlinear, camera.invViewProjection,
//                                 camera.cameraPosition.xyz, camera.cameraFar)
```

`camera.invViewProjection` es la combinación `inv(proj * view)` precalculada en CPU — no multiplicar `invView * invProj` por separado.
