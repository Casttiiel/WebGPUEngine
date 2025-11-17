// Near Blur Pass - Aplica blur solo a píxeles del foreground (CoC negativo)

struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projectionMatrix: mat4x4<f32>,
    viewProjectionMatrix: mat4x4<f32>,
    inverseViewMatrix: mat4x4<f32>,
    inverseProjectionMatrix: mat4x4<f32>,
    position: vec3<f32>,
    near: f32,
    far: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

// G-Buffer textures
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormals: texture_2d<f32>;
@group(1) @binding(2) var gLinearDepth: texture_2d<f32>;
@group(1) @binding(3) var samplerGBuffer: sampler;

@group(2) @binding(0) var inputTexture: texture_2d<f32>;
@group(2) @binding(1) var cocTexture: texture_2d<f32>;
@group(2) @binding(2) var inputSampler: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let cocData = textureSample(cocTexture, inputSampler, uv);
    let nearCoC = cocData.g; // Canal G contiene near CoC
    let originalColor = textureSample(inputTexture, inputSampler, uv);
    
    // Sample en patrón Poisson disk con radio proporcional al CoC
    let resolution = vec2<f32>(textureDimensions(inputTexture));
    let texelSize = 1.0 / resolution;
    
    // Poisson disk de 12 samples (balance calidad/rendimiento)
    let poissonDisk = array<vec2<f32>, 12>(
        vec2<f32>(-0.326212, -0.405805),
        vec2<f32>(-0.840144, -0.073580),
        vec2<f32>(-0.695914, 0.457137),
        vec2<f32>(-0.203345, 0.620716),
        vec2<f32>(0.962340, -0.194983),
        vec2<f32>(0.473434, -0.480026),
        vec2<f32>(0.519456, 0.767022),
        vec2<f32>(0.185461, -0.893124),
        vec2<f32>(0.507431, 0.064425),
        vec2<f32>(0.896420, 0.412458),
        vec2<f32>(-0.321940, -0.932615),
        vec2<f32>(-0.791559, -0.597710)
    );
    
    var color = vec4<f32>(0.0);
    var totalWeight = 0.0;
    
    // Blur con radio variable según CoC
    let blurRadius = nearCoC * texelSize.y;
    
    for (var i = 0; i < 12; i++) {
        let offset = poissonDisk[i] * blurRadius;
        let sampleUV = uv + offset;
        
        // Sample color y CoC del vecino
        let sampleColor = textureSample(inputTexture, inputSampler, sampleUV);
        let sampleCoCData = textureSample(cocTexture, inputSampler, sampleUV);
        let sampleNearCoC = sampleCoCData.g;
        
        // Weight: píxeles con más blur contribuyen más (evita bleeding del fondo)
        let weight = select(0.2, 1.0, max(sampleNearCoC, nearCoC) > 0.5);
        
        color += sampleColor * weight;
        totalWeight += weight;
    }
    
    let blurredColor = color / max(totalWeight, 0.001);
    
    // Si no hay blur en foreground, retornar color original; sino, retornar blur
    return select(originalColor, blurredColor, nearCoC >= 0.5);
}
