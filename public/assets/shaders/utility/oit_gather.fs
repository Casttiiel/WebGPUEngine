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
    let baseAlpha = texColor.a  * factors.baseColorFactor.a;
    // Roughness from txRoughness.g (GBuffer convention)
    let roughness = textureSample(txRoughness, samplerState, input.Uv).g * factors.roughnessFactor;

    // ── Normal mapping ─────────────────────────────────────────────────────────
    let normalSample = textureSample(txNormal, samplerState, input.Uv).rgb * 2.0 - 1.0;
    let N = normalize(input.N);
    let T = normalize(input.T.xyz);
    let B = cross(N, T) * input.T.w;
    let worldNormal = normalize(T * normalSample.x + B * normalSample.y + N * normalSample.z);

    // ── Fresnel (Schlick, glass IOR 1.5 → F0 = 0.04) ──────────────────────────
    let V      = normalize(camera.cameraPosition.xyz - input.WorldPos);
    let NdotV  = saturate(dot(worldNormal, V));
    let fresnel = 0.04 + 0.96 * pow(1.0 - NdotV, 5.0);

    // ── IBL specular reflection ────────────────────────────────────────────────
    // Reflect view ray about the surface normal and sample the prefiltered env cubemap.
    // envMip: roughness=0 → sharp reflections (mip 0), roughness=1 → blurry (mip 10).
    let R       = reflect(-V, worldNormal);
    let envMip  = roughness * 10.0;
    let envColor = textureSampleLevel(txEnv, envSampler, R, envMip).rgb;

    // Fresnel boosts alpha at grazing angles (classic glass rim effect)
    let alpha = mix(baseAlpha, 1.0, fresnel * 0.9);

    // Base color tinted by glass + env reflections weighted by Fresnel
    let color = baseColor * (1.0 - fresnel) + envColor * fresnel;

    // ── OIT weight function ────────────────────────────────────────────────────
    let z = input.position.z; // window-space depth [0, 1]
    let w = clamp(
        pow(min(1.0, alpha * 10.0) + 0.01, 3.0) * 1e8 * pow(1.0 - z * 0.9, 3.0),
        1e-2, 3e3
    );

    var output: OITOutput;
    output.accumulation = vec4<f32>(color * alpha * w, alpha * w);
    output.revealage    = vec4<f32>(alpha, 0.0, 0.0, alpha);
    return output;
}
