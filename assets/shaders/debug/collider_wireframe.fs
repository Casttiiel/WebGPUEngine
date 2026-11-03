struct VertexOutput {
    @builtin(position) clipPos : vec4<f32>,
    @location(0)       color   : vec4<f32>,
};

// GBuffer scene depth — same view that post-processing shaders already sample.
// We read it here for a software depth test (Reverse Z: near=1, far=0).
@group(1) @binding(0) var sceneDepth : texture_depth_2d;

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
    let px          = vec2<i32>(i32(input.clipPos.x), i32(input.clipPos.y));
    let storedDepth = textureLoad(sceneDepth, px, 0);

    // Reverse Z: a fragment is BEHIND stored geometry when its depth is smaller.
    // Discard occluded fragments so scene geometry properly hides the wireframe.
    if (input.clipPos.z < storedDepth) {
        discard;
    }

    return input.color;
}
