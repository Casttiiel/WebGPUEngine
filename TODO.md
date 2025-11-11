Particles Improvement:
CRÍTICO (10-50% performance gain)

1. Eliminar Compaction Serial
   Implementar parallel stream compaction
   O usar instanced rendering sin compaction (skip dead particles en shader)

🟠 ALTO (5-15% gain)

1. Dead Particle Free List
   O(1) spawn lookups
   Elimina scan linear
2. Reuse CPU Buffers
   No allocar Float32Array cada frame
   Reduce GC pressure

-----------------------------------Graphics Engine Backlog-----------------------------------
Change physics engine to ammo.js
Directional light: Positioning/Rotation
Directional light: Shadows correctness
GLTF Loader: Alpha Cutoff/Transparent number -> Should be a distorsion, pero que pasa con metallic/roughness/reflejos?
Motion Blur
Froxel Scattering
Voxel Global Illumination

---------------------------------------Game Engine Backlog-----------------------------------
Automatic geometry instancing
Test Camera Mixer/Use Correct camera again/TweakPane for Camera Mixer
Animations
Grain
Depth of Field (DOF)
Lens Flare
Atmospheric shadowing
Area Light (LTC (Linearly Transformed Cosines) for shadows)
Parallax Mapping
Subsurface Scattering (SSS) (If we need to extend the gbuffer, work on decals normals)
Atmospheric scattering (Simular skybox y cielo) / Fix Skybox
CSM: 3-cascade system
Shadow mapping (PCF/PCSS, cascaded for directional)(Unbounded number of shadow-casting point lights using shadow map cache)
Console
Weighted terrain
Grass
Physics Grass
Mesh LOD
Light Clustered culling + instancing
Occlusion culling / Multi-Strategy Culling System
Auto exposure
TAA: Anti-aliasing temporal
