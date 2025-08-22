// Include octahedral functions directly here to avoid include issues
fn encodeOctahedral(normal: vec3<f32>) -> vec2<f32> {
    let p = normal.xy / (abs(normal.x) + abs(normal.y) + abs(normal.z));
    if (normal.z <= 0.0) {
        let octWrap = (1.0 - abs(p.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), p.xy >= vec2<f32>(0.0));
        return octWrap;
    }
    return p;
}

fn decodeOctahedral(encoded: vec2<f32>) -> vec3<f32> {
    var normal = vec3<f32>(encoded.x, encoded.y, 1.0 - abs(encoded.x) - abs(encoded.y));
    if (normal.z < 0.0) {
        normal.x = (1.0 - abs(normal.y)) * select(-1.0, 1.0, normal.x >= 0.0);
        normal.y = (1.0 - abs(normal.x)) * select(-1.0, 1.0, normal.y >= 0.0);
    }
    return normalize(normal);
}

fn normalToOctahedral01(normal: vec3<f32>) -> vec2<f32> {
    let octNormal = encodeOctahedral(normal);
    return octNormal * 0.5 + 0.5;
}

fn octahedral01ToNormal(encoded: vec2<f32>) -> vec3<f32> {
    let octNormal = encoded * 2.0 - 1.0;
    return decodeOctahedral(octNormal);
}