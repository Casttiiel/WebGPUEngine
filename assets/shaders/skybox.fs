@group(1) @binding(0) var gAlbedo: texture_cube<f32>;
@group(1) @binding(1) var gAlbedoSampler: sampler;

@fragment
fn fs(@location(0) worldDir: vec3<f32>) -> @location(0) vec4<f32> {
    // Sample the cubemap using the world space direction we computed in the vertex shader
    let textureColor = textureSample(gAlbedo, gAlbedoSampler, normalize(worldDir));
    
    return vec4<f32>(textureColor.xyz, 1.0);
}