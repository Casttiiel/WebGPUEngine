### Engine

1. Character animator
2. Global Illumination Radiance Cascades
3. Editor Camera (Render Debug / Gizmo / Menu)
4. Clouds
5. Grass Influence Map / Chunks
6. Trees Generator / https://www.youtube.com/watch?v=GOfttJQ-FGw
7. Material Instances
8. Fire https://www.youtube.com/watch?v=Y1ZBzIiP-v4
9. Water Shader Reflections + Better Foam
10. [Blender] GLTF Exporter unifies metaltlic and roughness? In right channel?
11. Procedural materials
12. World Partition / Scene Streaming
13. Anamorphic lens flare
14. LOD automático para meshes
    Integrar meshoptimizer (npm, WASM oficial) en el pipeline de carga de Mesh.ts. Al cargar un .glb/mesh, generar 3 niveles de LOD en CPU con meshopt_simplify (error cuadrático). El GPUCullingManager ya tiene distancia a cámara por objeto — seleccionar el LOD activo en el buffer de culling según umbral de distancia configurable. Incluye LOD crossfade con dithering para transiciones invisibles (el campo lodFadeStart ya existe en GrassVolumeComponent, el patrón está definido).

## Gameplay

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection
