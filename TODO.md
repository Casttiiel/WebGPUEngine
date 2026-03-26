### Engine

1. Dithering para transparencias y gradientes — muy barato, muy efectivo
2. Sombras con dithering pixelado
3. AO Weird + Slow
4. DBuffer (Compare my Deferred renderer with UE)
5. SSR works on one direction only
6. HZB Culling regulero

7. Froxel Self Occlusion
8. Froxel Density Volumes
9. Light Shafts pixelados
10. Voxel Cone Tracing
11. Enemy AI
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
15. Staggered cascades
