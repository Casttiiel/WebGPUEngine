GBUFFER------------------------------

1. Parallax
2. Mesh LOD
3. Subsurface Scattering (SSS) (If we need to extend the gbuffer, work on decals normals)

DIRECT LIGHTING PASS------------------------------

1. Fix Spot Lights
2. Fix spot lights with shadows (shadow quality on component info) (shadow tap reduced)
3. Shadow mapping (PCF/PCSS, cascaded for directional)(Unbounded number of shadow-casting point lights using shadow map cache)
4. Area Light (LTC (Linearly Transformed Cosines) for shadows)
5. CSM: 3-cascade system
6. Atmospheric shadowing

AMBIENT OCCLUSION------------------------------
FAKED INDIRECT LIGHTING------------------------------
IBL / SKYLIGHT------------------------------

1. Screen space global illumination
2. Atmospheric scattering (Simular skybox y cielo)

SPECULAR / REFLECTION PASS------------------------------
VOLUMETRIC FOG / LIGHT SHAFTS------------------------------

1. Volumetric scattering (lighting/fog)

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

Terrain with perlin noise
Weighted terrain
Test Camera Mixer/Use Correct camera again/TweakPane for Camera Mixer
Music
Physics
Animations
Skybox with Day/Night Cycle
Day/Night Cycle
Grass
Physics Grass
Paralax Mapping (Needs height map!)
Grain
Camera Lens Dirt
Depth of Field (DOF)
Atmospheric shadowing
