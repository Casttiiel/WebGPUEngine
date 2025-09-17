Frame N:
├── 🔄 2. Light Injection (Compute) - 0.3ms  
│ └── ⏳ Inyecta luz directa de light sources

GBUFFER------------------------------
DIRECT LIGHTING PASS------------------------------

1. Fix Spot Lights
2. Fix spot lights with shadows (shadow quality on component info) (shadow tap reduced)
3. Shadow mapping (PCF/PCSS, cascaded for directional)(Unbounded number of shadow-casting point lights using shadow map cache)

AMBIENT OCCLUSION------------------------------
FAKED INDIRECT LIGHTING------------------------------
IBL / SKYLIGHT------------------------------
SPECULAR / REFLECTION PASS------------------------------
VOLUMETRIC FOG / LIGHT SHAFTS------------------------------
POST PROCESSING------------------------------

1. TAA: Anti-aliasing temporal
2. Motion Blur

OTHER------------------------------

1. Particles
2. GPU-Driven Rendering
3. Automatic geometry instancing

GAME-----------------------------------

Sound
Physics
Weighted terrain
Test Camera Mixer/Use Correct camera again/TweakPane for Camera Mixer
Animations
Grass
Physics Grass
Grain
Depth of Field (DOF)
Atmospheric shadowing
Area Light (LTC (Linearly Transformed Cosines) for shadows)
Mesh LOD
Parallax Mapping
Subsurface Scattering (SSS) (If we need to extend the gbuffer, work on decals normals)
Atmospheric scattering (Simular skybox y cielo)
Lens Flare
Light Clustered culling + instancing
Occlusion culling / Multi-Strategy Culling System
CSM: 3-cascade system
Auto exposure
