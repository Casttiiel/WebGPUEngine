#include "common/uniforms"
#include "common/structs"
#include "common/utils"

struct DecalFragmentOutput {
    @location(0) albedo: vec4<f32>,
    @location(1) selfIllum: vec4<f32>,
}

struct DecalVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) decal_top_left: vec3<f32>,
    @location(1) decal_axis_x: vec3<f32>,
    @location(2) decal_axis_z: vec3<f32>,
    @location(3) decal_axis_y: vec3<f32>,
    @location(4) uv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> object: ObjectUniforms;
@group(2) @binding(0) var txAlbedo: texture_2d<f32>;
@group(2) @binding(1) var txNormal: texture_2d<f32>;
@group(2) @binding(2) var txMetallic: texture_2d<f32>;
@group(2) @binding(3) var txRoughness: texture_2d<f32>;
@group(2) @binding(4) var txEmissive: texture_2d<f32>;
@group(2) @binding(5) var samplerState: sampler;

@fragment
fn fs(input: DecalVertexOutput) -> DecalFragmentOutput {
    // Screen coordinates
    let screen_pos = input.position.xy / camera.screenSize;

    // Sample depth buffer to get linear depth
    let depth = textureSample(txNormal, samplerState, screen_pos).x;
    
    // Recover world position from depth
    let world_pos = getWorldCoords(screen_pos, depth, camera);
    
    // Convert to local decal space (exactly like MCV_Supermarket)
    let decal_top_left_to_wPos = world_pos - input.decal_top_left;
    let amount_of_x = dot(decal_top_left_to_wPos, input.decal_axis_x);
    let amount_of_z = dot(decal_top_left_to_wPos, input.decal_axis_z);
    let amount_of_y = dot(decal_top_left_to_wPos, input.decal_axis_y);
    
    // Check bounds (0-1 range for UV projection)
    if (amount_of_x < 0.0 || amount_of_x > 1.0 || amount_of_z < 0.0 || amount_of_z > 1.0) {
        //discard;
    }
    
    // Sample decal texture using projected coordinates
    let decal_uv = vec2<f32>(amount_of_x, amount_of_z);
    let albedo_color = textureSample(txAlbedo, samplerState, decal_uv);
    let emissive_color = textureSample(txEmissive, samplerState, decal_uv);
    
    // Vertical fade factor
    let vertical_factor = 1.0 - abs(amount_of_y * 2.0);
    
    // Final alpha with opacity and vertical fade
    let final_alpha = albedo_color.a * vertical_factor;
    
    // Discard if alpha too low
    if (final_alpha < 0.01) {
        //discard;
    }
    
    var output: DecalFragmentOutput;
    
    // Output with color modulation
    output.albedo = vec4<f32>(albedo_color.rgb, final_alpha);
    output.selfIllum = vec4<f32>(emissive_color.rgb, final_alpha);
    
    return output;
}