### Engine

1.  Better loading speed (6600ms)
    🟡 Complejidad media — Cambios controlados 3. Paralelizar environment_manager + render en el arranque → −400~500ms estimado
    Son independientes entre sí — render no usa datos del environment manager. Bastaría con Promise.all([startModule(env), startModule(render)]) en vez de ejecutarlos en serie. El resto sí depende del render (entities, physics, etc.) y quedan en serie. Ganancia neta: casi los 507ms del env_manager quedan solapados.

🔴 Mayor complejidad — Alto impacto 5. Pipeline parse+load por entidad en ModuleBoot → −400ms estimado
(El que se discutió en la sesión anterior — cada entidad raíz hace parse→flag→load de forma independiente sin esperar al GLTF más pesado)

7. Contact Shadows
8. High Sponza low frame rate on near doors
9. Multiple Light probes has good shadows?
10. Reflection Probes con blending

11. Point light shadows banding
12. SS Global Illumination
13. Optimize with compute shaders

14. Clouds: Raymarching con Noise 3D (Horizon Zero Dawn / The Witcher 3)
15. Froxel Density Volumes
16. Froxel: Self occlusion
17. Froxel Global Illumination
18. UI
19. Improve particles

## Gameplay

Actions: Jump, Wall Run, Horizontal Wall Jump, Mantle, Vertical Wall Jump, Fast Fall, Slide, Dash

1. Jump right on change inclination and then wallrun
2. Blur on borders
3. Momentum

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection

### Editor

16. Editor Light Probes (Render Debug / Gizmo)
17. Editor Point Lights (Render Debug / Gizmo / Menu)
18. Editor Spot Lights (Render Debug / Gizmo / Menu)
19. Editor Camera (Render Debug / Gizmo / Menu)
20. Blender Export with player spawn
21. Asset Browser + Spawn + Delete
