### Engine

1. SSR Temporal
2. Froxel Self Occlusion
3. Froxel Volumetrics Temporal
4. GI Precomputed + probes
5. HZB Pocho

## Gameplay

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection

### Non Priority

1. Froxel Density Volumes
2. Enemy AI
   Fase 2 — Navegación real
   ├── Waypoint graph (authorado en Blender → JSON)
   ├── A\* sobre el grafo
   └── PathFollower / Steering (seek + arrive)
   → El enemigo ahora rodea obstáculos

   Fase 3 — Polish
   └── AnimationStateMachine driven by BT state
   (idle → patrol → chase → attack)

3. Glass (Uncharted)
4. Epipolar light scattering
5. Light shafts occlusion
6. Editor Point Lights (Render Debug / Gizmo / Menu)
7. Editor Spot Lights (Render Debug / Gizmo / Menu)
8. Editor Light Probes (Render Debug / Gizmo)
9. Editor Camera (Render Debug / Gizmo / Menu)
10. Blender Export with player spawn
11. Asset Browser + Spawn + Delete
12. Chromatic Aberration - Desplazamiento RGB radial en los bordes 🔵 Bajo
13. Vignette - Oscurecimiento suave en bordes de pantalla 🔵 Bajo
14. Grain / Film grain - Ruido animado de película
15. Lens flares Oclusión + flare radial para el sol
16. Clearcoat - Segunda capa especular encima del PBR base
17. Sheen - Retroreflexión de telas
18. Thin-film / Iridescence - Interferencia de películas finas (burbujas, insectos, nácar)
19. Transmission + refracción física - Sketchfab traza el rayo real a través del material; tú tienes distorsión simple
