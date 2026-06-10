// Fullscreen composite pass: upscales the half-resolution cloud texture onto
// the accumulation buffer.  The pipeline's depth-equal test ensures this pass
// only runs on sky pixels (depth == 1.0), so clouds never appear over geometry.

@group(1) @binding(0) var cloudTex:     texture_2d<f32>;
@group(1) @binding(1) var cloudSampler: sampler;

struct FsIn {
    @location(0) position_clip: vec3f,
    @builtin(position) fragCoord: vec4f,
}

@fragment
fn fs(in: FsIn) -> @location(0) vec4f {
    // Derive full-screen size from the half-res cloud texture (cloudDims * 2 ≈ full res).
    let cloudDims = vec2f(textureDimensions(cloudTex));
    let uv = in.fragCoord.xy / (cloudDims * 2.0);
    return textureSample(cloudTex, cloudSampler, uv);
}
