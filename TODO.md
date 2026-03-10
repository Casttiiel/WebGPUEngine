### Engine

1. Horizon clipping en IBL - Evita que la irradiancia difusa ilumine desde abajo del horizonte
2. Transmission + refracción física - Sketchfab traza el rayo real a través del material; tú tienes distorsión simple
3. Emissive strength > 1.0 correctamente en HDR - Sketchfab usa emissiveFactor real en HDR antes del tonemapper; tú guardas un escalar en el GBuffer que puede saturar

4. Normals good?
5. Performance (Copy GBuffer textures to bind group?)

6. Trail first point is what?
7. AO Weird?
8. Antialiasing Better?
9. HZB Culling regulero

10. Chromatic Aberration - Desplazamiento RGB radial en los bordes 🔵 Bajo
11. Vignette - Oscurecimiento suave en bordes de pantalla 🔵 Bajo
12. Color grading LUT Transformación de color 3D LUT con interpolación trilineal
13. Grain / Film grain - Ruido animado de película
14. Lens flares Oclusión + flare radial para el sol

15. Glass
16. Clearcoat - Segunda capa especular encima del PBR base
17. Sheen - Retroreflexión de telas
18. Thin-film / Iridescence - Interferencia de películas finas (burbujas, insectos, nácar)

19. Froxel Self Occlusion
20. Froxel Density Volumes
21. Voxel Cone Tracing
22. Gameplay
23. Enemy AI
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

### Editor

1. Editor Point Lights (Render Debug / Gizmo / Menu)
2. Editor Spot Lights (Render Debug / Gizmo / Menu)
3. Editor Light Probes (Render Debug / Gizmo)
4. Editor Camera (Render Debug / Gizmo / Menu)
5. Blender Export with player spawn
6. Asset Browser + Spawn + Delete
