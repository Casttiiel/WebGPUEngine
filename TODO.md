### Engine

1. Froxel Density Volumes
2. Froxel Wind/Noise de aqui: https://www.reddit.com/r/GraphicsProgramming/comments/1qu2fzz/faking_fog_volumes_in_screen_space_by_using_depth/
3. Enemy AI
   Fase 2 — Navegación real
   ├── Waypoint graph (authorado en Blender → JSON)
   ├── A\* sobre el grafo
   └── PathFollower / Steering (seek + arrive)
   → El enemigo ahora rodea obstáculos
4. GI Precomputed + probes
5. SSR Temporal
6. HZB Pocho

## Gameplay

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection

### Non Priority

1. Glass (Uncharted)
2. Epipolar light scattering
3. Light shafts occlusion
4. Editor Point Lights (Render Debug / Gizmo / Menu)
5. Editor Spot Lights (Render Debug / Gizmo / Menu)
6. Editor Light Probes (Render Debug / Gizmo)
7. Editor Camera (Render Debug / Gizmo / Menu)
8. Blender Export with player spawn
9. Asset Browser + Spawn + Delete
10. Chromatic Aberration - Desplazamiento RGB radial en los bordes 🔵 Bajo
11. Vignette - Oscurecimiento suave en bordes de pantalla 🔵 Bajo
12. Grain / Film grain - Ruido animado de película
13. Lens flares Oclusión + flare radial para el sol
14. Clearcoat - Segunda capa especular encima del PBR base
15. Sheen - Retroreflexión de telas
16. Thin-film / Iridescence - Interferencia de películas finas (burbujas, insectos, nácar)
17. Transmission + refracción física - Sketchfab traza el rayo real a través del material; tú tienes distorsión simple
