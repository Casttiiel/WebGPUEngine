#include "common/uniforms"
#include "common/structs"
#include "common/octahedral"
#include "common/gbuffer"

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// G-Buffer — albedo needed to modulate indirect irradiance (Lambertian: L = irradiance * albedo)
@group(1) @binding(0) var gAlbedo:      texture_2d<f32>;
@group(1) @binding(1) var gNormals:     texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

// Filtered SSGI irradiance (output of bilateral filter pass)
@group(2) @binding(0) var ssgiTexture: texture_2d<f32>;
@group(2) @binding(1) var samplerSSGI: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let g = decodeGBuffer(uv);

    // Skip skybox pixels
    if (g.zlinear > 0.999) {
        return vec4<f32>(0.0);
    }

    // SSGI may be rendered at lower resolution — bilinear upsample via simpleSampler
    // textureSampleLevel used (level 0) to avoid uniform control flow restriction
    let ssgiIrradiance = textureSampleLevel(ssgiTexture, samplerSSGI, uv, 0.0).rgb;

    // Lambertian indirect: L_diffuse_indirect = irradiance * albedo
    // The cosine-weighted sampling in ssgi.fs already cancels the PI in the BRDF denominator,
    // so we only need to multiply by the diffuse albedo (no metallic surfaces get GI diffuse).
    let diffuseAlbedo = g.albedo * (1.0 - g.metallic);

    return vec4<f32>(ssgiIrradiance * diffuseAlbedo, 0.0);
}
