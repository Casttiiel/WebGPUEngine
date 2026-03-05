#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"
#include "common/math/coordinates"
#include "common/octahedral"

struct DecalFragmentOutput {
  @location(0) albedo: vec4<f32>,     // RGB: albedo, A: metallic
  @location(1) normal: vec4<f32>,     // RGB: world normal, A: roughness
}

struct DecalVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) decal_top_left: vec3<f32>,
    @location(1) decal_axis_x: vec3<f32>,
    @location(2) decal_axis_z: vec3<f32>,
    @location(3) decal_axis_y: vec3<f32>,
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
@group(3) @binding(3) var samplerState2: sampler;


@fragment
fn fs(input: DecalVertexOutput) -> DecalFragmentOutput {
    // Screen coordinates
    let screen_pos = input.position.xy / camera.screenSize;

    // Sample depth buffer to get linear depth
    let depth = textureSample(gLinearDepth, samplerState, screen_pos).x;
    
    // Recover world position from depth
    let world_pos = getWorldCoords(screen_pos, depth, camera);
    
    let decal_top_left_to_wPos = world_pos - input.decal_top_left;
    let axis_x_len = length(input.decal_axis_x);
    let axis_z_len = length(input.decal_axis_z);
    let axis_y_len = length(input.decal_axis_y);
    let amount_of_x = dot(decal_top_left_to_wPos, input.decal_axis_x) / (axis_x_len * axis_x_len);
    let amount_of_z = dot(decal_top_left_to_wPos, input.decal_axis_z) / (axis_z_len * axis_z_len);
    let amount_of_y = dot(decal_top_left_to_wPos, input.decal_axis_y) / (axis_y_len * axis_y_len);

    // Check bounds (0-1 range for UV projection, ±0.5 for vertical)
    if (amount_of_x < 0.0 || amount_of_x > 1.0 || amount_of_z < 0.0 || amount_of_z > 1.0) {
        discard;
    }
    if (abs(amount_of_y) > 0.5) { discard; }

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

    let decal_roughness = textureSample(txRoughness, samplerState, decal_uv).g;
    let emissive_color = textureSample(txEmissive, samplerState, decal_uv);
    
    var output: DecalFragmentOutput;

    // Mezcla solo los canales RGB, deja el canal A intacto
    let orig_albedo = textureSample(gBufferAlbedo, samplerState, screen_pos);
    let out_albedo_rgb = mix(orig_albedo.rgb, decal_albedo.rgb, final_alpha);
    let out_albedo_a = mix(orig_albedo.a, decal_albedo.a, final_alpha); // Mix metallic as well

    let orig_NRoughnessEmissive = textureSample(gBufferNormals, samplerState, screen_pos);

    let orig_normal = octahedral01ToNormal(orig_NRoughnessEmissive.xy);
    // Fallback prevents NaN when orig_normal ≈ up (cross product ≈ zero)
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(orig_normal.y) > 0.99);
    let tangent = normalize(cross(up, orig_normal));
    let bitangent = cross(orig_normal, tangent);
    let TBN = mat3x3<f32>(tangent, bitangent, orig_normal);
    let decal_normal_ts = textureSample(txNormal, samplerState, decal_uv) * 2.0 - 1.0;
    let decal_normal_ws = normalize(TBN * decal_normal_ts.xyz);
    let encodedNormal = normalToOctahedral01(decal_normal_ws);

    let blended_roughness = mix(orig_NRoughnessEmissive.z, decal_roughness, final_alpha);

    // Output with color modulation
    output.albedo = vec4<f32>(out_albedo_rgb, out_albedo_a);
    output.normal = vec4<f32>(encodedNormal.xy, blended_roughness, orig_NRoughnessEmissive.a);

    return output;
}