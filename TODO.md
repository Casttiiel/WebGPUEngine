### Engine

1. Irradiance esta mal calculado (bentnormals)
2. Review Ambient y specular shader
3. Regenerate environment/irradiance texture
4. Procedural Skybox better
5. Test Mip Fog with skybox
6. SMAA + TAA
7. Area light
8. HZB Pocho
9. GI Precomputed + probes o Staggered/Radiance cascades

10. Screen-space god rays / sun volumetrics — el sistema de 4 passes que ya tienes (occlusion mask → radial blur → Kawase → composite).
11. Froxel Self Occlusion
12. Froxel Density Volumes
13. UE Retro Shaders
14. Consistency between dither / Dither size
15. Enemy AI
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
