### Engine

1. Mips Good?
2. Sponza decals mask/transparency
3. HZB Culling regulero
4. Normals good?
5. Texture Quality
6. Performance
7. AO Weird?
8. Antialiasing Better?

9. Specular occlusion desde AO - Sketchfab aplica specularOcclusion = saturate(pow(NdV + AO, exp2(-16R²-1)) - 1 + AO) al especular IBL — tú lo tienes en ambient_specular.fs pero revisar si llega al IBL diffuse
10. Multi-scattering energy compensation Kulla-Conty - el GGX single-scattering pierde energía con roughness alto → superficie oscura incorrecta
11. Emissive strength > 1.0 correctamente en HDR - Sketchfab usa emissiveFactor real en HDR antes del tonemapper; tú guardas un escalar en el GBuffer que puede saturar
12. Transmission + refracción física - Sketchfab traza el rayo real a través del material; tú tienes distorsión simple

13. PCSS (Soft Shadows) Percentage Closer Soft Shadows — la penumbra crece con la distancia al caster
14. Shadow cascade blending - Sketchfab mezcla suavemente entre cascadas CSM; tú haces corte duro 🟡 Medio

15. IBL Specular con filtrado correcto - Tu ambient_specular.fs usa la cubemap pero ¿la tienes pre-filtrada con roughness mips? Sketchfab usa textureSampleLevel(envMap, sampler, R, roughness \* MAX_MIP)
16. Horizon clipping en IBL - Evita que la irradiancia difusa ilumine desde abajo del horizonte

17. Chromatic Aberration - Desplazamiento RGB radial en los bordes 🔵 Bajo
18. Vignette - Oscurecimiento suave en bordes de pantalla 🔵 Bajo
19. Color grading LUT Transformación de color 3D LUT con interpolación trilineal
20. Grain / Film grain - Ruido animado de película
21. Lens flares Oclusión + flare radial para el sol

22. Glass
23. Clearcoat - Segunda capa especular encima del PBR base
24. Sheen - Retroreflexión de telas
25. Thin-film / Iridescence - Interferencia de películas finas (burbujas, insectos, nácar)

26. Froxel Self Occlusion
27. Froxel Density Volumes
28. Voxel Cone Tracing
29. Gameplay
30. Enemy AI
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
