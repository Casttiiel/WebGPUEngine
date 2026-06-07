### Engine

1. Skinned meshes cast shadows + is using wrong MIP textures
2. Camera arm offsets + is popping
3. Character animator
4. Global Illumination Radiance Cascades
5. Editor Camera (Render Debug / Gizmo / Menu)
6. Clouds
7. Grass Influence Map / Chunks
8. Trees Generator / https://www.youtube.com/watch?v=GOfttJQ-FGw
9. Material Instances
10. Fire https://www.youtube.com/watch?v=Y1ZBzIiP-v4
11. Water Shader Reflections + Better Foam
12. [Blender] GLTF Exporter unifies metaltlic and roughness? In right channel?
13. Procedural materials
14. World Partition / Scene Streaming
15. Anamorphic lens flare
16. LOD automático para meshes
    Integrar meshoptimizer (npm, WASM oficial) en el pipeline de carga de Mesh.ts. Al cargar un .glb/mesh, generar 3 niveles de LOD en CPU con meshopt_simplify (error cuadrático). El GPUCullingManager ya tiene distancia a cámara por objeto — seleccionar el LOD activo en el buffer de culling según umbral de distancia configurable. Incluye LOD crossfade con dithering para transiciones invisibles (el campo lodFadeStart ya existe en GrassVolumeComponent, el patrón está definido).

## Gameplay

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection
