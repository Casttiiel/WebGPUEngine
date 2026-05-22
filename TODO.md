### Engine

2. LOD automático para meshes
   Coste: Medio | Impacto: Performance crítico en escenas grandes

Integrar meshoptimizer (npm, WASM oficial) en el pipeline de carga de Mesh.ts. Al cargar un .glb/mesh, generar 3 niveles de LOD en CPU con meshopt_simplify (error cuadrático). El GPUCullingManager ya tiene distancia a cámara por objeto — seleccionar el LOD activo en el buffer de culling según umbral de distancia configurable. Incluye LOD crossfade con dithering para transiciones invisibles (el campo lodFadeStart ya existe en GrassVolumeComponent, el patrón está definido).

1. NavMesh Generation non blocking
2. Limpieza de prefabs, materiales, techniques, componentes, meshes, texturas, shaders,
3. Grass Influence Map / Chunks
4. Trees Generator / https://www.youtube.com/watch?v=GOfttJQ-FGw
5. Material Instances
6. Fire https://www.youtube.com/watch?v=Y1ZBzIiP-v4
7. [Blender] GLTF Exporter unifies metaltlic and roughness? In right channel?
8. Water Shader Reflections + Better Foam
9. Procedural materials
10. Radiance Cascades
11. World Partition / Scene Streaming
12. Editor Camera (Render Debug / Gizmo / Menu)
13. Asset Spawn + Delete

## Gameplay

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection
