// Fullscreen composite: blends the temporally-resolved cloud texture onto the
// accumulation buffer.  The depth-equal test on the pipeline ensures this pass
// only executes on sky pixels (depth == 1.0), preventing clouds from rendering
// over geometry.  No upscaling needed here — the temporal resolve pass already
// produced a full-resolution result.

@group(1) @binding(0) var cloudTex:     texture_2d<f32>;
@group(1) @binding(1) var cloudSampler: sampler;

struct FsIn {
    @location(0) position_clip: vec3f,
    @builtin(position) fragCoord: vec4f,
}

@fragment
fn fs(in: FsIn) -> @location(0) vec4f {
    let uv = vec2f(in.position_clip.x * 0.5 + 0.5,
                   0.5 - in.position_clip.y * 0.5);
    return textureSample(cloudTex, cloudSampler, uv);
}
