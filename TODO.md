1. Particles / GPU-Driven Rendering
   Requirements:

Spawneo de partículas

Las partículas nacen con posición, velocidad y tiempo de vida configurables.
El sistema puede emitir nuevas partículas en slots libres.
El spawn puede ser controlado por parámetros (ratio, dirección, rango, color, tamaño, etc.).
Actualización en GPU (Compute Shader)

La posición, velocidad, edad y estado (viva/muerta) de cada partícula se actualizan en un compute shader.
El shader gestiona el movimiento, la física y la muerte de partículas (cuando el tiempo de vida se agota).
Renderizado eficiente

Solo se dibujan las partículas vivas.
Se usa instanced rendering y billboarding para que cada quad mire a la cámara.
El vertex shader accede a los datos de cada partícula usando instanceIndex y un storage buffer.
Para máxima eficiencia, se usa indirect draw calls (el compute shader actualiza el buffer de draw indirect con el número de partículas vivas).
Acceso a todos los datos por partícula

Cada partícula tiene: posición, velocidad, tiempo de vida, edad, estado activo, y opcionalmente color/tamaño.
El sistema puede crecer en atributos sin límite de locations (usando storage buffer).
Recursos GPU y arquitectura

Storage Buffer: Array de partículas con todos los datos.
Indirect Draw Buffer: Buffer con los parámetros de draw call (instanceCount = partículas vivas).

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
