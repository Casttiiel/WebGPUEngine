### Engine

1. Screen-space god rays — (occlusion mask → radial blur → Kawase → composite)

   **Plan de implementación**

   **Step 1 — Occlusion mask pass** ✅ DONE

   - [x] Crear `GodRaysComponent.ts` con ciclo de vida ECS (load / apply / resize / dispose)
   - [x] Shader `god_rays_occlusion.fs` — renderiza la escena en baja resolución (¼), occluders negros, cielo/sol blanco
   - [x] Obtener la posición del sol en NDC cada frame (directional light dir + cámara viewProj) y pasarla como uniform
   - [x] `GodRaysParams` buffer: posición sol (NDC), threshold, densidad, decay, weight (32 bytes, 8 × f32)
   - [x] RenderTarget `occlusion_mask` a ¼ de resolución (`rgba8unorm`, `writesOn: "mask"`)
   - [x] **Depth-aware occlusion**: usar el depth del GBuffer (no re-renderizar la escena) para occluders reales — necesario para interiores y sombras de geometría correctas. Añadir `GBufferUniforms` al shader y descartar píxeles cuyo `linearDepth < zFar` antes del threshold test.

   **Step 2 — Radial blur pass (light shaft)**

   - [x] Shader `god_rays_radial.fs` — **64 samples** (no 128) desde el pixel hacia el sol con decay acumulado; 64 es el estándar de referencia (Doom Eternal) y mitad del coste en hardware modesto
   - [x] Raymarching loop con paso variable derivado de `density`; **sin jitter por frame** (no hay TAA aún); jitter puede añadirse en Step 6 si se integra TAA
   - [x] RenderTarget `radial_blur` al mismo tamaño que occlusion mask (`rgba8unorm`)
   - [x] Uniforms: `numSamples` (64), `density`, `decay`, `weight`, `exposure`

   **Step 3 — Kawase blur pass (suavizado)**

   - [ ] Shader `god_rays_kawase.fs` — 4 taps con offsets para suavizar bandas radiales
   - [ ] **4-5 passes** de Kawase en ping-pong con offsets `0, 1, 2, 2, 3` — dos passes son insuficientes y dejan bandas visibles a ¼ resolución
   - [ ] RenderTargets ping-pong (`rgba8unorm`, tamaño ¼ — pueden reutilizarse de bloom si mismo formato/size)

   **Step 4 — Composite pass**

   - [ ] Shader `god_rays_composite.fs` — additive blend del resultado Kawase sobre el frame **HDR** (antes de tone mapping)
   - [ ] Color del sol: **samplear la cubemap de entorno (`environmentTexture`) en la dirección del sol** — un uniform fijo se desincroniza con ciclos día/noche y cambios de color. Si no hay cubemap, fallback a uniform tint
   - [ ] Opción `blendMode`: additive puro (por defecto) o multiplicativo con tint

   **Step 5 — Integración en el motor**

   - [x] Añadir `god_rays` al prefab de la cámara (`main_camera.prefab`)
   - [x] Insertar el paso en `ModuleRender.ts`: **después de `auto_exposure`, antes de `tone_mapping`** (los god rays son energía lumínica HDR — sumarlos post-tonemapping mezcla espacios lineales y tonemapeados). Orden final: Lighting → Auto Exposure → God Rays → Tone Mapping → FXAA/SMAA → FSR
   - [x] Registrar component en `Loader.ts` (switch case `'god_rays'`)
   - [x] Handle `resize()` para recrear los RTs al cambiar resolución
   - [x] Técnica JSON `god_rays_occlusion.tech` con `writesOn: "mask"` (nuevo target `rgba8unorm`)
   - [ ] Técnicas JSON `god_rays_radial.tech`, `god_rays_kawase.tech`, `god_rays_composite.tech`

   **Step 6 — Calidad y edge cases**

   - [ ] Early-exit si el sol está fuera del frustum (skip todos los passes) — ya se computa `sunNdcX/Y`, basta con `abs(sunNdc) > 1 + margin`
   - [ ] Fade-out cuando el sol se acerca al borde de pantalla (evitar corte brusco) — multiplicar `weight` por `smoothstep(1.2, 0.8, max(abs(sunNdcX), abs(sunNdcY)))`
   - [ ] Exposición adaptativa: escalar `weight` según `AutoExposureComponent.getExposureBuffer()` si está activo
   - [ ] Jitter temporal (Step 2): añadir `camera.jitterOffset` al inicio del raymarching cuando TAA esté disponible

2. GI Precomputed + probes o Staggered/Radiance cascades
3. AA/TAA
4. HZB Pocho
5. Froxel Self Occlusion
6. Froxel Density Volumes
7. Consistency between dither / Dither size
8. Enemy AI
   Fase 2 — Navegación real
   ├── Waypoint graph (authorado en Blender → JSON)
   ├── A\* sobre el grafo
   └── PathFollower / Steering (seek + arrive)
   → El enemigo ahora rodea obstáculos

   Fase 3 — Polish
   └── AnimationStateMachine driven by BT state
   (idle → patrol → chase → attack)

## Gameplay

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection

### Non Priority

1. Editor Point Lights (Render Debug / Gizmo / Menu)
2. Editor Spot Lights (Render Debug / Gizmo / Menu)
3. Editor Light Probes (Render Debug / Gizmo)
4. Editor Camera (Render Debug / Gizmo / Menu)
5. Blender Export with player spawn
6. Asset Browser + Spawn + Delete
7. Chromatic Aberration - Desplazamiento RGB radial en los bordes 🔵 Bajo
8. Vignette - Oscurecimiento suave en bordes de pantalla 🔵 Bajo
9. Grain / Film grain - Ruido animado de película
10. Lens flares Oclusión + flare radial para el sol
11. Clearcoat - Segunda capa especular encima del PBR base
12. Sheen - Retroreflexión de telas
13. Thin-film / Iridescence - Interferencia de películas finas (burbujas, insectos, nácar)
14. Transmission + refracción física - Sketchfab traza el rayo real a través del material; tú tienes distorsión simple
15. Glass (Uncharted)
