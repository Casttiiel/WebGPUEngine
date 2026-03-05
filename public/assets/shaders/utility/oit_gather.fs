// Weighted Blended Order-Independent Transparency — Gather Pass
// McGuire & Bavoil (2013): http://jcgt.org/published/0002/02/09/
//
// Renders GLASS geometry into two accumulation targets:
//   @location(0) accumulation (RGBA16F) — additive blend
//   @location(1) revealage    (RGBA8)   — multiplicative (1-alpha) blend
//
// A second compose pass resolves these over the opaque accLight buffer.

#include "common/structs"
#include "common/uniforms"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txAlbedo:    texture_2d<f32>;
@group(1) @binding(1) var txNormal:    texture_2d<f32>;
@group(1) @binding(2) var txMetallic:  texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive:  texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;
// Environment cubemap + BRDF LUT for IBL specular (injected by GlassOITGatherRenderPass)
@group(3) @binding(0) var txEnv:     texture_cube<f32>;
@group(3) @binding(1) var envSampler: sampler;
@group(3) @binding(2) var txBRDF:    texture_2d<f32>;  // split-sum LUT: U=NdotV, V=roughness

struct OITOutput {
    @location(0) accumulation: vec4<f32>,
    @location(1) revealage:    vec4<f32>,
};

@fragment
fn fs(input: VertexOutput) -> OITOutput {
    let texColor  = textureSample(txAlbedo, samplerState, input.Uv);
    let baseColor = texColor.rgb * factors.baseColorFactor.rgb;
    var baseAlpha = texColor.a * factors.baseColorFactor.a;
    // Roughness from txRoughness.g (GBuffer convention)
    let roughness = textureSample(txRoughness, samplerState, input.Uv).g * factors.roughnessFactor;

    // ── View vector (must be computed before TBN to orient the geometric normal) ─
    let V = normalize(camera.cameraPosition.xyz - input.WorldPos);

    // ── Normal mapping ─────────────────────────────────────────────────────────
    let normalSample = textureSample(txNormal, samplerState, input.Uv).rgb * 2.0 - 1.0;
    let N_geo = normalize(input.N);
    // Face-forward: for double-sided glass the back-face interpolated normal points
    // away from the camera → dot(N,V) < 0 → saturate gives 0 → Fresnel = 1 always.
    // Flip N to always face the viewer so Fresnel varies correctly on both sides.
    let N = select(N_geo, -N_geo, dot(N_geo, V) < 0.0);
    // Gram-Schmidt re-orthogonalise T against the corrected N.
    let T = normalize(input.T.xyz - dot(input.T.xyz, N) * N);
    let B = cross(N, T) * input.T.w;
    let worldNormal = normalize(T * normalSample.x + B * normalSample.y + N * normalSample.z);

    // ── Fresnel (Schlick, glass IOR 1.5 → F0 = 0.04) ──────────────────────────
    let NdotV  = saturate(dot(worldNormal, V));
    let fresnel = 0.04 + 0.96 * pow(1.0 - NdotV, 5.0);

    // ── IBL specular con split-sum BRDF (Karis / UE4 2013) ────────────────────
    // Without the LUT the reflection weight is plain Fresnel, which ignores that
    // high roughness disperses the specular lobe — overestimates by ~35% at r=0.6.
    let R        = reflect(-V, worldNormal);
    let envMip   = roughness * 10.0;
    let envColor = textureSampleLevel(txEnv, envSampler, R, envMip).rgb;

    // BRDF LUT: U = NdotV, V = roughness  →  .r = F0 scale,  .g = additive bias
    let brdf        = textureSampleLevel(txBRDF, samplerState, vec2<f32>(NdotV, roughness), 0.0).rg;
    let F0          = vec3<f32>(0.04);                       // glass IOR 1.5
    let envStrength = F0 * brdf.r + brdf.g;                 // vec3 split-sum weight

    // ── Alpha with Fresnel coupling ────────────────────────────────────────────
    // At grazing angles Fresnel is high → more light reflected → less transmitted
    // → glass should appear more opaque there. factor 0.6 is conservative.
    // baseAlpha=0.08 + fresnel=0.72 → alpha≈0.48 at grazing (physically correct rim)
    let fresnelAlphaBoost = fresnel * (1.0 - baseAlpha) * 0.6;
    let alpha = clamp(baseAlpha + fresnelAlphaBoost, 0.0, 1.0);

    // Color: glass tint for transmitted light + env for reflected, weighted by split-sum
    let color = baseColor * (1.0 - envStrength) + envColor * envStrength;

    // ── OIT weight function — near-range aware ─────────────────────────────────
    // Problem: with far=1000, z = depth/far compresses 0–5m into z < 0.005.
    // Everything clamps to the same weight → OIT can't order near-field layers.
    // Fix: normalise to nearRange so [0, nearRange] maps to [0, 1] — the region
    // with the most detail (interior glass, windows, displays).
    let viewDepth = -(camera.viewMatrix * vec4<f32>(input.WorldPos, 1.0)).z;
    let nearRange = 5.0;   // metres — tune for your scene (interiors: 2–5m)
    let z_near    = clamp(viewDepth / nearRange,       0.0, 1.0);
    let z_far     = clamp(viewDepth / camera.cameraFar, 0.0, 1.0);
    let z_blend   = max(z_near, z_far * 0.1);
    let depthTerm = 10.0 / (1e-5 + pow(z_blend / 0.1, 2.0) + pow(z_blend / 0.5, 6.0));
    let w = clamp(alpha * clamp(depthTerm, 1e-2, 3e3), 1e-2, 3e3);

    var output: OITOutput;
    output.accumulation = vec4<f32>(color * alpha * w, alpha * w);
    output.revealage    = vec4<f32>(alpha, 0.0, 0.0, alpha);
    return output;
}
