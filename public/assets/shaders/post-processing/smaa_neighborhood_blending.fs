#include "common/uniforms"

// SMAA Pass 3: Neighborhood Blending
// Reference: "Enhanced Subpixel Morphological Antialiasing" by Jorge Jimenez et al.
// Uses blend weights from Pass 2 to perform offset-based bilinear filtering

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var colorTex: texture_2d<f32>;
@group(1) @binding(1) var colorSampler: sampler;
@group(2) @binding(0) var blendTex: texture_2d<f32>;
@group(2) @binding(1) var blendSampler: sampler;

fn SMAAMovc(cond: vec2<bool>, variable: ptr<function, vec2<f32>>, value: vec2<f32>) {
    if (cond.x) { (*variable).x = value.x; }
    if (cond.y) { (*variable).y = value.y; }
}

fn SMAAMovc4(cond: vec4<bool>, variable: ptr<function, vec4<f32>>, value: vec4<f32>) {
    if (cond.x) { (*variable).x = value.x; }
    if (cond.y) { (*variable).y = value.y; }
    if (cond.z) { (*variable).z = value.z; }
    if (cond.w) { (*variable).w = value.w; }
}

@fragment
fn fs(@builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    
    // Calculate texel size
    let texelSize = 1.0 / camera.screenSize;
    
    // Calculate offset: mad(vec4(texelSize, texelSize), vec4(1.0, 0.0, 0.0, 1.0), uv.xyxy)
    // offset.xy = uv + vec2(texelSize.x, 0.0)  -> right neighbor
    // offset.zw = uv + vec2(0.0, texelSize.y)  -> bottom neighbor
    let offset = vec4<f32>(
        uv.x + texelSize.x, uv.y,           // xy: right
        uv.x, uv.y + texelSize.y            // zw: bottom
    );
    
    var color: vec4<f32>;

    // Fetch the blending weights for current pixel:
    // CRITICAL: Match exact channel mapping from GLSL reference
    var a: vec4<f32>;
    a.x = textureSampleLevel(blendTex, blendSampler, offset.xy, 0.0).a; // Right
    a.y = textureSampleLevel(blendTex, blendSampler, offset.zw, 0.0).g; // Top

    if (dot(a, vec4<f32>(1.0)) <= 1e-5) {
        return textureSampleLevel(colorTex, colorSampler, uv, 0.0);
    }

    let temp = textureSampleLevel(blendTex, blendSampler, uv, 0.0);
    a.w = temp.x; // Bottom (using .x which is left weight - confusing naming in original)
    a.z = temp.z; // Left (using .z which is top weight - confusing naming in original)

    // Is there any blending weight with a value greater than 0.0?
    if (dot(a, vec4<f32>(1.0)) <= 1e-5) {
        color = textureSampleLevel(colorTex, colorSampler, uv, 0.0);//vec4<f32>(0);
    } else {
        let h: bool = max(a.x, a.z) > max(a.y, a.w); // max(horizontal) > max(vertical)

        // Calculate the blending offsets:
        var blendingOffset: vec4<f32> = vec4<f32>(0.0, a.y, 0.0, a.w);
        var blendingWeight: vec2<f32> = a.yw;
        SMAAMovc4(vec4<bool>(h, h, h, h), &blendingOffset, vec4<f32>(a.x, 0.0, a.z, 0.0));
        SMAAMovc(vec2<bool>(h, h), &blendingWeight, a.xz);
        blendingWeight /= dot(blendingWeight, vec2<f32>(1.0));

        // Calculate the texture coordinates:
        let blendingCoord: vec4<f32> = blendingOffset * vec4<f32>(texelSize.x, texelSize.y, -texelSize.x, -texelSize.y) + vec4<f32>(uv.xy, uv.xy);

        // We exploit bilinear filtering to mix current pixel with the chosen neighbor:
        color = blendingWeight.x * textureSampleLevel(colorTex, colorSampler, blendingCoord.xy, 0.0);
        color += blendingWeight.y * textureSampleLevel(colorTex, colorSampler, blendingCoord.zw, 0.0);
    }

    return color;
}
