@fragment
fn fs(@location(0) N: vec3<f32>,
    @location(1) Uv: vec2<f32>,
    @location(2) WorldPos: vec3<f32>,
    @location(3) T: vec4<f32>,) -> @location(0) vec4<f32> {
    return vec4<f32>(Uv.x,Uv.y, N.z, 1.0);
}

