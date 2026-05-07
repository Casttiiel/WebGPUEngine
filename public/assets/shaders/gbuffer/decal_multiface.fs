#include "common/uniforms"
#include "common/structs"
#include "common/math/matrices"
#include "common/math/coordinates"
#include "common/octahedral"

struct DecalFragmentOutput {
  @location(0) albedo: vec4<f32>,
  @location(1) normal: vec4<f32>,
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
    let screen_pos = input.position.xy / camera.screenSize;

    let depth = textureSample(gLinearDepth, samplerState, screen_pos).x;
    let world_pos = getWorldCoords(screen_pos, depth, camera);

    let decal_to_wpos = world_pos - input.decal_top_left;
    let axis_x_len = length(input.decal_axis_x);
    let axis_z_len = length(input.decal_axis_z);
    let axis_y_len = length(input.decal_axis_y);
    let amount_of_x = dot(decal_to_wpos, input.decal_axis_x) / (axis_x_len * axis_x_len);
    let amount_of_z = dot(decal_to_wpos, input.decal_axis_z) / (axis_z_len * axis_z_len);
    let amount_of_y = dot(decal_to_wpos, input.decal_axis_y) / (axis_y_len * axis_y_len);

    // Discard fragments outside the decal cube volume.
    // All three axes are now [0, 1] from the minimum corner (decal_multiface.vs
    // subtracts decal_y * 0.5 from decal_top_left, unlike the original decal.vs).
    if (amount_of_x < 0.0 || amount_of_x > 1.0 ||
        amount_of_z < 0.0 || amount_of_z > 1.0 ||
        amount_of_y < 0.0 || amount_of_y > 1.0) {
        discard;
    }

    // Surface normal from GBuffer
    let orig_NRoughnessEmissive = textureSample(gBufferNormals, samplerState, screen_pos);
    let surface_normal = normalize(octahedral01ToNormal(orig_NRoughnessEmissive.xy));

    // Normalized face directions in world space
    let face_xp = normalize(input.decal_axis_x);
    let face_xn = -face_xp;
    let face_yp = normalize(input.decal_axis_y);
    let face_yn = -face_yp;
    let face_zp = normalize(input.decal_axis_z);
    let face_zn = -face_zp;

    // Per-face weight: raised to power 4 so each face wins clearly in its zone
    // and transitions at corners are sharp rather than blurry 50/50 blends.
    let w_xp = pow(max(0.0, dot(surface_normal, face_xp)), 4.0);
    let w_xn = pow(max(0.0, dot(surface_normal, face_xn)), 4.0);
    let w_yp = pow(max(0.0, dot(surface_normal, face_yp)), 4.0);
    let w_yn = pow(max(0.0, dot(surface_normal, face_yn)), 4.0);
    let w_zp = pow(max(0.0, dot(surface_normal, face_zp)), 4.0);
    let w_zn = pow(max(0.0, dot(surface_normal, face_zn)), 4.0);

    let total_weight = w_xp + w_xn + w_yp + w_yn + w_zp + w_zn;
    if (total_weight < 0.001) { discard; }

    // UVs for each of the 6 face projections
    // X faces: project along X → UV from (Z, Y)
    let uv_xp = vec2<f32>(amount_of_z,       amount_of_y);
    let uv_xn = vec2<f32>(1.0 - amount_of_z, amount_of_y);
    // Y faces: project along Y → UV from (X, Z)
    let uv_yp = vec2<f32>(amount_of_x,       amount_of_z);
    let uv_yn = vec2<f32>(amount_of_x,       1.0 - amount_of_z);
    // Z faces: project along Z → UV from (X, Y)
    let uv_zp = vec2<f32>(amount_of_x,       amount_of_y);
    let uv_zn = vec2<f32>(1.0 - amount_of_x, amount_of_y);

    // Albedo blend
    let albedo_xp = textureSample(txAlbedo, samplerState, uv_xp);
    let albedo_xn = textureSample(txAlbedo, samplerState, uv_xn);
    let albedo_yp = textureSample(txAlbedo, samplerState, uv_yp);
    let albedo_yn = textureSample(txAlbedo, samplerState, uv_yn);
    let albedo_zp = textureSample(txAlbedo, samplerState, uv_zp);
    let albedo_zn = textureSample(txAlbedo, samplerState, uv_zn);

    let decal_albedo = (
        albedo_xp * w_xp + albedo_xn * w_xn +
        albedo_yp * w_yp + albedo_yn * w_yn +
        albedo_zp * w_zp + albedo_zn * w_zn
    ) / total_weight;

    // Per-axis edge softness in [0,1]: 1 at cube centre along that axis, 0 at the face.
    let edge_x = 1.0 - abs((amount_of_x - 0.5) * 2.0);
    let edge_y = 1.0 - abs((amount_of_y - 0.5) * 2.0);
    let edge_z = 1.0 - abs((amount_of_z - 0.5) * 2.0);

    // Each face's fade must only use its two UV axes — NOT its own depth axis.
    // Including the depth axis would zero-out surfaces sitting right on that face
    // (e.g. a floor at amount_of_y ≈ -0.5 would get edge_y ≈ 0 and never render).
    //   X-faces project along X  → UV axes are Z and Y
    //   Y-faces project along Y  → UV axes are X and Z
    //   Z-faces project along Z  → UV axes are X and Y
    let edge_fade_x = min(edge_y, edge_z);
    let edge_fade_y = min(edge_x, edge_z);
    let edge_fade_z = min(edge_x, edge_y);

    let edge_fade = (
        edge_fade_x * (w_xp + w_xn) +
        edge_fade_y * (w_yp + w_yn) +
        edge_fade_z * (w_zp + w_zn)
    ) / total_weight;

    let final_alpha = decal_albedo.a * edge_fade;
    if (final_alpha < 0.01) { discard; }

    // Roughness blend
    let rough_xp = textureSample(txRoughness, samplerState, uv_xp).g;
    let rough_xn = textureSample(txRoughness, samplerState, uv_xn).g;
    let rough_yp = textureSample(txRoughness, samplerState, uv_yp).g;
    let rough_yn = textureSample(txRoughness, samplerState, uv_yn).g;
    let rough_zp = textureSample(txRoughness, samplerState, uv_zp).g;
    let rough_zn = textureSample(txRoughness, samplerState, uv_zn).g;

    let decal_roughness = (
        rough_xp * w_xp + rough_xn * w_xn +
        rough_yp * w_yp + rough_yn * w_yn +
        rough_zp * w_zp + rough_zn * w_zn
    ) / total_weight;

    // Normal map blend in tangent space
    let nm_xp = textureSample(txNormal, samplerState, uv_xp).xyz * 2.0 - 1.0;
    let nm_xn = textureSample(txNormal, samplerState, uv_xn).xyz * 2.0 - 1.0;
    let nm_yp = textureSample(txNormal, samplerState, uv_yp).xyz * 2.0 - 1.0;
    let nm_yn = textureSample(txNormal, samplerState, uv_yn).xyz * 2.0 - 1.0;
    let nm_zp = textureSample(txNormal, samplerState, uv_zp).xyz * 2.0 - 1.0;
    let nm_zn = textureSample(txNormal, samplerState, uv_zn).xyz * 2.0 - 1.0;

    // Build TBN from the underlying surface normal once.
    let orig_normal = octahedral01ToNormal(orig_NRoughnessEmissive.xy);
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(orig_normal.y) > 0.99);
    let tangent   = normalize(cross(up, orig_normal));
    let bitangent = cross(orig_normal, tangent);
    let TBN = mat3x3<f32>(tangent, bitangent, orig_normal);

    // Each face's tangent-space normal lives in a different tangent space, so
    // transform each one to world space individually before blending.
    // Mixing raw tangent-space vectors from different projections is incorrect.
    let ws_xp = normalize(TBN * nm_xp);
    let ws_xn = normalize(TBN * nm_xn);
    let ws_yp = normalize(TBN * nm_yp);
    let ws_yn = normalize(TBN * nm_yn);
    let ws_zp = normalize(TBN * nm_zp);
    let ws_zn = normalize(TBN * nm_zn);

    let decal_normal_ws = normalize(
        ws_xp * w_xp + ws_xn * w_xn +
        ws_yp * w_yp + ws_yn * w_yn +
        ws_zp * w_zp + ws_zn * w_zn
    );
    let encoded_normal  = normalToOctahedral01(decal_normal_ws);

    // Blend onto GBuffer
    let orig_albedo = textureSample(gBufferAlbedo, samplerState, screen_pos);
    let out_albedo_rgb = mix(orig_albedo.rgb, decal_albedo.rgb, final_alpha);
    let out_albedo_a   = mix(orig_albedo.a,   decal_albedo.a,   final_alpha);
    let blended_roughness = mix(orig_NRoughnessEmissive.z, decal_roughness, final_alpha);

    var output: DecalFragmentOutput;
    output.albedo = vec4<f32>(out_albedo_rgb, out_albedo_a);
    output.normal = vec4<f32>(encoded_normal.xy, blended_roughness, orig_NRoughnessEmissive.a);
    return output;
}
