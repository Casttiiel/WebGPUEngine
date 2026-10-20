// Cubemap utilities for IBL and environment mapping
// Level 0: No dependencies

// Convert UV coordinates and face index to 3D direction
fn uvToDirection(uv: vec2<f32>, face: u32) -> vec3<f32> {
    let u = uv.x * 2.0 - 1.0; // [-1, 1]
    let v = uv.y * 2.0 - 1.0; // [-1, 1]
    
    var dir: vec3<f32>;
    
    switch face {
        case 0u: { dir = vec3<f32>(1.0, -v, -u); }   // +X
        case 1u: { dir = vec3<f32>(-1.0, -v, u); }   // -X
        case 2u: { dir = vec3<f32>(u, 1.0, v); }     // +Y
        case 3u: { dir = vec3<f32>(u, -1.0, -v); }   // -Y
        case 4u: { dir = vec3<f32>(u, -v, 1.0); }    // +Z
        default: { dir = vec3<f32>(-u, -v, -1.0); }  // -Z
    }
    
    return normalize(dir);
}

// Generate orthonormal basis (TBN matrix) from normal vector
fn generateTBN(normal: vec3<f32>) -> mat3x3<f32> {
    var up = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(normal.y) > 0.999) {
        up = vec3<f32>(1.0, 0.0, 0.0);
    }
    
    let tangent = normalize(cross(up, normal));
    let bitangent = cross(normal, tangent);
    
    return mat3x3<f32>(tangent, bitangent, normal);
}
