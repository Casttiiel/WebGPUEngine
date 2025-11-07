1. Particles / GPU-Driven Rendering
   Requirements:

   1. El update de las particulas debe ser en gpu
   2. Sistema de particulas que usa compute shaders
   3. Configurable: escoger radio de spawn de particulas, rango de color de particulas, tamaño, tiempo de vida, direccion de movimiento, velocidad de movimiento, ratio/tiempo de spawn de particulas
   4. Debe generar particulas en base al ratio de spawn, ademas de actualizar las ya existentes y interpolar entre los valores iniciales/finales
   5. Solo debe pintar las particulas activas/vivas
   6. Spawn totalmente en GPU, usando acumulador interno
   7. DrawIndirect para solo dibujar partículas activas

2. Change physics engine to ammo.js

Backlog-----------------------------------
Auto exposure
New/Old Bloom
Motion Blur
TAA: Anti-aliasing temporal
Froxel Scattering
Directional light: Positioning/Rotation
Directional light: Shadows correctness
Fix skybox
Automatic geometry instancing
Light Clustered culling + instancing
Occlusion culling / Multi-Strategy Culling System

Grain
Depth of Field (DOF)
Lens Flare
Atmospheric shadowing
Area Light (LTC (Linearly Transformed Cosines) for shadows)
Parallax Mapping
Subsurface Scattering (SSS) (If we need to extend the gbuffer, work on decals normals)
Atmospheric scattering (Simular skybox y cielo)
CSM: 3-cascade system
Shadow mapping (PCF/PCSS, cascaded for directional)(Unbounded number of shadow-casting point lights using shadow map cache)
Console
Test Camera Mixer/Use Correct camera again/TweakPane for Camera Mixer
Weighted terrain
Animations
Grass
Physics Grass
Mesh LOD
