// Shared by gbuffer_pom.vs / gbuffer_pom.fs.

struct POMVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(perspective, centroid) N: vec3<f32>,
    @location(1) @interpolate(perspective, centroid) Uv: vec2<f32>,
    @location(2) @interpolate(perspective, centroid) WorldPos: vec3<f32>,
    @location(3) @interpolate(perspective, centroid) T: vec4<f32>,
    // Object box (unit cube × model matrix): world centre, unit axes, half extents in metres.
    @location(4) @interpolate(flat) BoxCenter: vec3<f32>,
    @location(5) @interpolate(flat) BoxAxisX: vec3<f32>,
    @location(6) @interpolate(flat) BoxAxisY: vec3<f32>,
    @location(7) @interpolate(flat) BoxAxisZ: vec3<f32>,
    @location(8) @interpolate(flat) BoxHalf: vec3<f32>,
}

// MaterialFactors + the extras block at offset 48 (renderer/resources/MaterialExtras.ts:
// same order, vec3s unpacked as three floats so nothing gets padded).
struct PomFactors {
    baseColorFactor: vec4<f32>,
    roughnessFactor: f32,
    metallicFactor: f32,
    emissiveFactor: f32,
    appearanceBlend: f32,
    uvXScale: f32,
    uvYScale: f32,
    surfaceBlend: f32,
    pomScale: f32,
    // extras
    pomShadow: f32,
    layerCoverage: f32,
    layerNoiseScale: f32,
    layerSharpness: f32,
    layerUvScale: f32,
    antiTileScale: f32,
    cavityDirt: f32,
    baseDirtHeight: f32,
    dirtColorR: f32,
    dirtColorG: f32,
    dirtColorB: f32,
    baseDirtStrength: f32,
    layerTintR: f32,
    layerTintG: f32,
    layerTintB: f32,
    layerHeightOffset: f32,
}
