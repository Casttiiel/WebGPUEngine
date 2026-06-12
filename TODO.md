### Engine

1. IA
2. Better foot IK foot angle + walking
3. Hi-Z SSR (mejor calidad de reflecciones)
4. Temporal upscaling mejorado (TSR con optical flow para objetos sin velocity) (Y con velocity?)
5. Character animator
6. Editor Camera (Render Debug / Gizmo / Menu)
7. Material Instances
8. [Blender] GLTF Exporter unifies metaltlic and roughness? In right channel?
9. Procedural materials
10. World Partition / Scene Streaming
11. LOD automático para meshes
    Integrar meshoptimizer (npm, WASM oficial) en el pipeline de carga de Mesh.ts. Al cargar un .glb/mesh, generar 3 niveles de LOD en CPU con meshopt_simplify (error cuadrático). El GPUCullingManager ya tiene distancia a cámara por objeto — seleccionar el LOD activo en el buffer de culling según umbral de distancia configurable. Incluye LOD crossfade con dithering para transiciones invisibles (el campo lodFadeStart ya existe en GrassVolumeComponent, el patrón está definido).

## VFX

1. Grass Influence Map / Chunks
2. Trees Generator / https://www.youtube.com/watch?v=GOfttJQ-FGw
3. Fire https://www.youtube.com/watch?v=Y1ZBzIiP-v4
4. Water Shader Reflections + Better Foam

## Gameplay

Jump / Double Jump
Maintain Gravity
Dash
Light Attack
Push Attack
Lift Attack
Mantle
(Batman Arkham style)

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection
