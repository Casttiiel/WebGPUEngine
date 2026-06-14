---------------------------------------Wishlist Backlog-----------------------------------

Reflejos planares (Planar Reflections)
Subsurface Scattering (SSS) (If we need to extend the gbuffer, work on decals normals)
TrimSheets
CRT Shader
Partículas: ribbons, meshes, beams
LOD automático para meshes
Integrar meshoptimizer (npm, WASM oficial) en el pipeline de carga de Mesh.ts. Al cargar un .glb/mesh, generar 3 niveles de LOD en CPU con meshopt_simplify (error cuadrático). El GPUCullingManager ya tiene distancia a cámara por objeto — seleccionar el LOD activo en el buffer de culling según umbral de distancia configurable. Incluye LOD crossfade con dithering para transiciones invisibles (el campo lodFadeStart ya existe en GrassVolumeComponent, el patrón está definido).
