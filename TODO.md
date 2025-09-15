Frame N:
├── 🔄 2. Light Injection (Compute) - 0.3ms  
│ └── ⏳ Inyecta luz directa de light sources

GBUFFER------------------------------

1. Parallax Mapping
2. Subsurface Scattering (SSS) (If we need to extend the gbuffer, work on decals normals)

DIRECT LIGHTING PASS------------------------------

1. Fix Spot Lights
2. Fix spot lights with shadows (shadow quality on component info) (shadow tap reduced)
3. Shadow mapping (PCF/PCSS, cascaded for directional)(Unbounded number of shadow-casting point lights using shadow map cache)
4. CSM: 3-cascade system

AMBIENT OCCLUSION------------------------------
FAKED INDIRECT LIGHTING------------------------------
IBL / SKYLIGHT------------------------------

1. Atmospheric scattering (Simular skybox y cielo)

SPECULAR / REFLECTION PASS------------------------------
VOLUMETRIC FOG / LIGHT SHAFTS------------------------------
POST PROCESSING------------------------------

1. TAA: Anti-aliasing temporal
2. Motion Blur
3. Auto exposure
4. Lens Flare

OTHER------------------------------

1. Particles
2. GPU-Driven Rendering
3. Automatic geometry instancing
4. Scene selector on Tweakpane
5. Light Clustered culling + instancing
6. Occlusion culling / Multi-Strategy Culling System
7. Buffer Reuse y Pooling

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
