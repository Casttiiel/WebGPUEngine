#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"
#include "common/octahedral"

// ─── Bind groups ────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(1) @binding(0) var txAlbedo:    texture_2d<f32>;
@group(1) @binding(1) var txNormal:    texture_2d<f32>;
@group(1) @binding(2) var txMetallic:  texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive:  texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(1) @binding(6) var<uniform> factors: MaterialFactors;

@group(2) @binding(0) var<uniform> object: ObjectUniforms;

@group(3) @binding(0) var gBufferAlbedo:  texture_2d<f32>;
@group(3) @binding(1) var gBufferNormals: texture_2d<f32>;
@group(3) @binding(2) var gLinearDepth:   texture_2d<f32>;
@group(3) @binding(3) var samplerGBuffer: sampler;

// ─── Output — writes two GBuffer targets (partial_gbuffer) ───────────────────
struct DecalFlatOutput {
    @location(0) albedo: vec4<f32>,   // RGB = albedo linear,  A = metallic
    @location(1) normal: vec4<f32>,   // RG  = octahedral N,   B = roughness, A = emissive
}

@fragment
fn fs(input: VertexOutput) -> DecalFlatOutput {
    let uv = input.Uv * vec2<f32>(factors.uvXScale, factors.uvYScale);

    // ── Sample decal textures ────────────────────────────────────────────────
    let albedo_srgb     = textureSample(txAlbedo,    samplerState, uv);
    let alpha           = albedo_srgb.a * factors.baseColorFactor.a;

    // Discard invisible pixels early to avoid unnecessary GBuffer reads
    if (alpha < 0.01) { discard; }

    // Linearize sRGB albedo and apply baseColorFactor in linear space
    let decal_albedo    = pow(abs(albedo_srgb.rgb), vec3<f32>(2.2)) * factors.baseColorFactor.rgb;
    let decal_metallic  = textureSample(txMetallic,  samplerState, uv).b * factors.metallicFactor;
    let decal_rough_raw = textureSample(txRoughness, samplerState, uv).g * factors.roughnessFactor;
    let decal_emissive  = textureSample(txEmissive,  samplerState, uv).x  * factors.emissiveFactor;

    // ── Read current GBuffer values at this screen pixel ────────────────────
    let screen_uv   = input.position.xy / camera.screenSize;
    let orig_albedo = textureSampleLevel(gBufferAlbedo,  samplerGBuffer, screen_uv, 0.0);
    let orig_normal = textureSampleLevel(gBufferNormals, samplerGBuffer, screen_uv, 0.0);

    // ── Albedo + metallic blend by alpha ─────────────────────────────────────
    let out_albedo   = mix(orig_albedo.rgb, decal_albedo,   alpha);
    let out_metallic = mix(orig_albedo.a,   decal_metallic, alpha);

    // ── Normal blend: apply decal normal map in mesh TBN, blend WS normals ──
    // Use the mesh's own TBN so the decal normal is oriented correctly even on
    // non-horizontal surfaces (walls, ceilings, etc.).
    let N         = normalize(input.N);
    let TBN       = computeTBN(N, input.T);
    let decal_n_ts = textureSample(txNormal, samplerState, uv).xyz * 2.0 - 1.0;
    let decal_n_ws = normalize(TBN * decal_n_ts);
    let orig_n_ws  = octahedral01ToNormal(orig_normal.xy);
    // Blend world-space normals then re-normalise before encoding
    let blended_n_ws = normalize(mix(orig_n_ws, decal_n_ws, alpha));
    let encoded_n    = normalToOctahedral01(blended_n_ws);

    // ── Roughness, with Specular Anti-Aliasing applied to the decal normal ───
    let dndx       = dpdx(decal_n_ws);
    let dndy       = dpdy(decal_n_ws);
    let variance   = dot(dndx, dndx) + dot(dndy, dndy);
    let kernel_r2  = min(2.0 * variance * 0.25, 0.18);
    let decal_rough = sqrt(clamp(decal_rough_raw * decal_rough_raw + kernel_r2, 0.0, 1.0));
    let out_roughness = mix(orig_normal.z, decal_rough, alpha);

    // ── Emissive blend ────────────────────────────────────────────────────────
    let out_emissive = mix(orig_normal.w, decal_emissive, alpha);

    var out: DecalFlatOutput;
    out.albedo = vec4<f32>(out_albedo,  out_metallic);
    out.normal = vec4<f32>(encoded_n,   out_roughness, out_emissive);
    return out;
}
