#include "common/uniforms"
#include "common/structs"
#include "common/utils"

struct DecalFragmentOutput {
  @location(0) albedo: vec4<f32>,     // RGB: albedo, A: metallic
  @location(1) normal: vec4<f32>,     // RGB: world normal, A: roughness
  @location(2) selfIllum: vec4<f32>,  // RGB: emissive, A: unused
}

struct DecalVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) decal_top_left: vec3<f32>,
    @location(1) decal_axis_x: vec3<f32>,
    @location(2) decal_axis_z: vec3<f32>,
    @location(3) decal_axis_y: vec3<f32>,
    @location(4) N: vec3<f32>,
    @location(5) T: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var txAlbedo: texture_2d<f32>;
@group(1) @binding(1) var txNormal: texture_2d<f32>;
@group(1) @binding(2) var txMetallic: texture_2d<f32>;
@group(1) @binding(3) var txRoughness: texture_2d<f32>;
@group(1) @binding(4) var txEmissive: texture_2d<f32>;
@group(1) @binding(5) var samplerState: sampler;
@group(2) @binding(0) var<uniform> object: ObjectUniforms;
@group(3) @binding(0) var gBufferAlbedo: texture_2d<f32>;
@group(3) @binding(1) var gBufferNormals: texture_2d<f32>;
@group(3) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(3) @binding(3) var gBufferSelfIllum: texture_2d<f32>;
@group(3) @binding(4) var samplerState2: sampler;


@fragment
fn fs(input: DecalVertexOutput) -> DecalFragmentOutput {
    // Screen coordinates
    let screen_pos = input.position.xy / camera.screenSize;

    // Sample depth buffer to get linear depth
    let depth = textureSample(gLinearDepth, samplerState, screen_pos).x;
    
    // Recover world position from depth
    let world_pos = getWorldCoords(screen_pos, depth, camera);
    
    let decal_top_left_to_wPos = world_pos - input.decal_top_left;
    let amount_of_x = dot(decal_top_left_to_wPos, input.decal_axis_x);
    let amount_of_z = dot(decal_top_left_to_wPos, input.decal_axis_z);
    let amount_of_y = dot(decal_top_left_to_wPos, input.decal_axis_y);
    
    // Check bounds (0-1 range for UV projection)
    if (amount_of_x < 0.0 || amount_of_x > 1.0 || amount_of_z < 0.0 || amount_of_z > 1.0) {
        discard;
    }
    
    // Sample decal texture using projected coordinates
    let decal_uv = vec2<f32>(amount_of_x, amount_of_z);
    let decal_albedo = textureSample(txAlbedo, samplerState, decal_uv);
    
    // Vertical fade factor
    let vertical_factor = 1.0 - abs(amount_of_y * 2.0);
    
    // Final alpha with opacity and vertical fade
    let final_alpha = decal_albedo.a * vertical_factor;
    
    // Discard if alpha too low
    if (final_alpha < 0.01) {
        discard;
    }

    let N_tangent_space = textureSample(txNormal, samplerState, decal_uv) * 2.0 - 1.0;
    let emissive_color = textureSample(txEmissive, samplerState, decal_uv);
    
    var output: DecalFragmentOutput;

    // Mezcla solo los canales RGB, deja el canal A intacto
    let orig_albedo = textureSample(gBufferAlbedo, samplerState, screen_pos);
    let out_albedo_rgb = mix(orig_albedo.rgb, decal_albedo.rgb, final_alpha);
    let out_albedo_a = orig_albedo.a; // Mantén el metallic original

    let TBN = computeTBN(normalize(input.N), input.T);
    let decal_normal = normalize(TBN * N_tangent_space.xyz);
    let orig_normals = textureSample(gBufferNormals, samplerState, screen_pos);
    let orig_normal = decodeNormal(orig_normals.rgb);
    let blended_normal = normalize(mix(orig_normal, decal_normal, final_alpha));
    let out_normal_rgb = encodeNormal(blended_normal, orig_normals.a); // Manten el roughness original


    // Output with color modulation
    output.albedo = vec4<f32>(out_albedo_rgb, out_albedo_a);
    output.normal = vec4<f32>(out_normal_rgb);
    output.selfIllum = vec4<f32>(emissive_color);

    return output;
}