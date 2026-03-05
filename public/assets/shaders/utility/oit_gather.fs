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
// Environment cubemap for IBL specular reflections (injected by GlassOITGatherRenderPass)
@group(3) @binding(0) var txEnv:     texture_cube<f32>;
@group(3) @binding(1) var envSampler: sampler;

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

    // ── IBL specular reflection ────────────────────────────────────────────────
    // Reflect view ray about the surface normal and sample the prefiltered env cubemap.
    // envMip: roughness=0 → sharp reflections (mip 0), roughness=1 → blurry (mip 10).
    let R        = reflect(-V, worldNormal);
    let envMip   = roughness * 10.0;
    let envColor = textureSampleLevel(txEnv, envSampler, R, envMip).rgb;

    // Alpha from material only — OIT revealage handles the blending.
    // No Fresnel boost here: it was making grazing edges opaque.
    var alpha = baseAlpha;

    // Color: glass tint blended with env reflection.
    // fresnel*0.5 keeps the reflections visible (pure 4% Schlick is too subtle at normal incidence)
    // but never overrides the glass tint at typical viewing angles.
    let envStrength = fresnel;
    let color = baseColor * (1.0 - envStrength) + envColor * envStrength;

    // ── OIT weight function (McGuire & Bavoil 2013, Appendix B) ───────────────
    // input.position.z is NDC — non-linear, useless for far=1000 scenes.
    // Use linear view depth normalized [0,1].
    let viewDepth = -(camera.viewMatrix * vec4<f32>(input.WorldPos, 1.0)).z;
    let z         = clamp(viewDepth / camera.cameraFar, 0.0, 1.0);
    // Reference formula: varies from ~1000 at z≈0 to ~0.03 at z=0.5
    // This gives 5m→w≈80 and 100m→w≈0.8, so near/far layers are correctly ordered.
    let depthTerm = 10.0 / (1e-5 + pow(z / 0.1, 2.0) + pow(z / 0.5, 6.0));
    let w = clamp(alpha * clamp(depthTerm, 1e-2, 3e3), 1e-2, 3e3);

    var output: OITOutput;
    output.accumulation = vec4<f32>(color * alpha * w, alpha * w);
    output.revealage    = vec4<f32>(alpha, 0.0, 0.0, alpha);
    return output;
}
