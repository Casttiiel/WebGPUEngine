// Normal map encoding/decoding
fn encodeNormal(n: vec3<f32>, nw: f32) -> vec4<f32> {
    return vec4<f32>((n + 1.0) * 0.5, nw);
}

fn decodeNormal(encodedNormal: vec3<f32>) -> vec3<f32> {
    return encodedNormal * 2.0 - 1.0;
}

// Matrix utilities
fn get3x3From4x4(mat: mat4x4<f32>) -> mat3x3<f32> {
    return mat3x3<f32>(
        mat[0].xyz,
        mat[1].xyz,
        mat[2].xyz
    );
}

// TBN matrix calculation
fn computeTBN(inputN: vec3<f32>, inputT: vec4<f32>) -> mat3x3<f32> {
    let N = inputN;
    let T = inputT.xyz;
    let B = cross(N, T) * inputT.w;
    return mat3x3<f32>(T, B, N);
}

// World position reconstruction from depth
fn getWorldCoords(coords: vec2<f32>, zlinear_normalized: f32, camera: CameraUniforms) -> vec3<f32> {
    let screen_coords = ((coords * 2.0) - 1.0) * camera.sourceSize;
    let view_dir_homogeneous = vec4<f32>(screen_coords, -1.0, 1.0);
    let view_dir = (camera.screenToWorld * view_dir_homogeneous).xyz;
    return view_dir * zlinear_normalized + camera.cameraPosition;
}
