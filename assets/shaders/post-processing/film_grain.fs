struct FilmGrainParams {
    intensity:  f32, // 0-1, grain strength
    grainSize:  f32, // 1-4, controls grain coarseness
    time:       f32, // animated seed (seconds), upload each frame for movement
    colorized:  f32, // 0 = monochrome grain, 1 = colored noise
}

@group(0) @binding(0) var inputTex:     texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(1) @binding(0) var<uniform> params: FilmGrainParams;

// Hash functions for noise generation
fn hash13(p: vec3f) -> f32 {
    var p3 = fract(p * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}

fn hash33(p: vec3f) -> vec3f {
    var p3 = fract(p * vec3f(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yxx) * p3.zyx);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    let color = textureSample(inputTex, inputSampler, uv);
    if params.intensity <= 0.0 {
        return color;
    }

    let texSize = vec2f(textureDimensions(inputTex));
    let pixel   = floor(uv * texSize / max(params.grainSize, 0.1));
    let seed    = vec3f(pixel, params.time);

    var grain: vec3f;
    if params.colorized > 0.5 {
        grain = hash33(seed) * 2.0 - 1.0;
    } else {
        let mono = hash13(seed) * 2.0 - 1.0;
        grain = vec3f(mono);
    }

    // Luminance-weighted mask: more grain on midtones, less on pure blacks
    let luminance  = dot(color.rgb, vec3f(0.299, 0.587, 0.114));
    let grainMask  = sqrt(max(luminance, 0.0));

    return vec4f(color.rgb + grain * params.intensity * grainMask, color.a);
}
