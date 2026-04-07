// ---------------------------------------------------------------------------
// water_volume.vs — Instanced LOD water vertex shader
//
// Each instance is a water patch.  The compute shader (water_lod.cs) bins
// patches into 3 LOD tiers and writes per-LOD DrawArgs + sorted instance
// arrays every frame.  The VS reads its patch descriptor from the per-LOD
// instance storage buffer bound at @group(2).
//
// Group layout:
//   @group(0) @binding(0)  camera     CameraUniforms
//   @group(1)              material   (noise1, noise2, sceneDepth, envCubemap,
//                                      samplers, factors — same as water.vs)
//   @group(2) @binding(0)  patches    array<PatchData>   (read-only-storage)
//
// Mesh: unit patch with vertices at x ∈ [0, 1], z ∈ [0, 1], y = 0.
//       Normals are (0, 1, 0). The VS scales+offsets to world space from
//       the PatchData and displaces along Y by animated noise.
// ---------------------------------------------------------------------------
#include "common/uniforms"
#include "common/structs"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// Per-instance patch descriptor (written by water_lod.cs each frame)
struct PatchData {
    worldX: f32,   // world-space X of patch corner (min X)
    worldZ: f32,   // world-space Z of patch corner (min Z)
    scale:  f32,   // world-space side length of the patch
    _pad:   f32,
}
@group(2) @binding(0) var<storage, read> patches: array<PatchData>;

// Noise textures + samplers from material group
@group(1) @binding(0) var txNoise1:    texture_2d<f32>;
@group(1) @binding(1) var txNoise2:    texture_2d<f32>;
@group(1) @binding(4) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;

@vertex
fn vs(
    @builtin(instance_index) instIdx: u32,
    @location(0) position:  vec3<f32>,
    @location(1) normal:    vec3<f32>,
    @location(2) uv:        vec2<f32>,
    @location(3) tangent:   vec4<f32>,
) -> VertexOutput {
    var output: VertexOutput;

    let patch = patches[instIdx];
    let t     = camera.time;

    // ── World-space XZ from unit mesh + patch descriptor ──────────────────
    // Unit mesh x,z ∈ [0,1].  Scale to patch world size, then shift to origin.
    let worldX = position.x * patch.scale + patch.worldX;
    let worldZ = position.z * patch.scale + patch.worldZ;

    // ── Animated noise UVs (world-space → seamless across patches) ────────
    let noiseScale = factors.uvXScale * 0.05;
    let noiseUV1 = vec2<f32>(worldX, worldZ) * noiseScale
                 + vec2<f32>(t * 0.06, t * 0.04);
    let noiseUV2 = vec2<f32>(worldX, worldZ) * factors.uvYScale * 0.05
                 + vec2<f32>(-t * 0.04, t * 0.07);

    let noise1 = textureSampleLevel(txNoise1, samplerState, noiseUV1, 0.0).r;
    let noise2 = textureSampleLevel(txNoise2, samplerState, noiseUV2, 0.0).g;
    let displacement = (noise1 * 0.6 + noise2 * 0.4 - 0.5) * 0.2;

    // ── Final world position (Y = displacement, no object model matrix) ───
    let worldPos = vec4<f32>(worldX, displacement, worldZ, 1.0);

    // Normals always point up for a horizontal water surface.
    // The fragment shader perturbs N with noise; tangent is along +X.
    output.N        = vec3<f32>(0.0, 1.0, 0.0);
    output.T        = vec4<f32>(1.0, 0.0, 0.0, 1.0);
    output.WorldPos = worldPos.xyz;
    output.Uv       = uv;
    output.position = camera.projectionMatrix * camera.viewMatrix * worldPos;

    return output;
}
