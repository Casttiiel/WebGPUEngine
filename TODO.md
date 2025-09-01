GBUFFER------------------------------

1. (TERCERO)Decals selective writing
2. Parallax / Detail maps
3. Mesh LOD
4. Subsurface Scattering (SSS)

DIRECT LIGHTING PASS------------------------------

1. Fix Spot Lights
2. Fix spot lights with shadows (shadow quality on component info) (shadow tap reduced)
3. Shadow mapping (PCF/PCSS, cascaded for directional)(Unbounded number of shadow-casting point lights using shadow map cache)
4. CSM: 3-cascade system
5. Area Light
6. Atmospheric shadowing

AMBIENT OCCLUSION------------------------------

1. (PRIMERO)Screen Space Ambient Occlusion (GTAO)
   Reproyeccion en Temporal accumulation

FAKED INDIRECT LIGHTING------------------------------

1. Faked indirect lighting
2. Global Ilumination

IBL / SKYLIGHT------------------------------

1. Diffuse IBL (irradiance map, prefiltered cube)
2. Specular IBL (pre-filtered envmap mip chain + BRDF LUT for Fresnel/roughness integration)
3. Atmospheric scattering

SPECULAR / REFLECTION PASS------------------------------

1. (SEGUNDO)Specular Occlusion
2. SSR raymarching algorithm

VOLUMETRIC FOG / LIGHT SHAFTS------------------------------

1. (CUARTO)Volumetric lighting/fog
2. Atmospheric shadowing

POST PROCESSING------------------------------

1. (QUINTO)Auto exposure
2. TAA: Anti-aliasing temporal o multi-sample.
3. Motion Blur
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
