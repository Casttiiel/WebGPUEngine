### Engine

1. Character animator
2. Foot IK
   Para sentirse bien de verdad (Arkham tiene estas):
3. TurnLeft_90 + TurnRight_90 — pivotes en sitio cuando estás parado y giras > 45°
4. TurnLeft_180 / TurnRight_180 — para inversión de dirección

Para IK en giros pequeños: sí, es la técnica correcta. Un LookAt IK en la cabeza/spine cuando el ángulo entre facing y velocity es < 30°. AnimatorComponent.addIkConstraint() ya lo soporta, solo necesitas el nombre del joint en el esqueleto.

3. Clouds
4. Editor Camera (Render Debug / Gizmo / Menu)
5. Anamorphic lens flare
6. Global Illumination Radiance Cascades
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

## Visuals and Sound

1. Start Screen
2. Game Loading Screen
3. Remove en main.ts el skip first frame?
4. Quality settings selection
