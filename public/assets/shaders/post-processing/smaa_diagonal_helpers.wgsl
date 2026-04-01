// SMAA Complete Helper Functions Library
// WGSL Implementation - Complete reference implementation

// ============================================================================
// BASIC HELPERS
// ============================================================================

// Helper: multiply-add
fn mad_f32(a: f32, b: f32, c: f32) -> f32 {
    return a * b + c;
}

fn mad_vec2(a: vec2<f32>, b: vec2<f32>, c: vec2<f32>) -> vec2<f32> {
    return a * b + c;
}

fn mad_vec4(a: vec4<f32>, b: vec4<f32>, c: vec4<f32>) -> vec4<f32> {
    return a * b + c;
}

// Sample texture with offset
fn SMAASampleLevelZeroOffset(
    tex: texture_2d<f32>,
    samp: sampler,
    coord: vec2<f32>,
    offset: vec2<i32>,
    texelSize: vec2<f32>
) -> vec4<f32> {
    return textureSampleLevel(tex, samp, coord + vec2<f32>(offset) * texelSize, 0.0);
}

// ============================================================================
// CONDITIONAL MOVE FUNCTIONS
// ============================================================================

fn SMAAMovc_vec2(cond: vec2<bool>, variable: ptr<function, vec2<f32>>, value: vec2<f32>) {
    if (cond.x) { (*variable).x = value.x; }
    if (cond.y) { (*variable).y = value.y; }
}

fn SMAAMovc_vec4(cond: vec4<bool>, variable: ptr<function, vec4<f32>>, value: vec4<f32>) {
    if (cond.x) { (*variable).x = value.x; }
    if (cond.y) { (*variable).y = value.y; }
    if (cond.z) { (*variable).z = value.z; }
    if (cond.w) { (*variable).w = value.w; }
}

// ============================================================================
// BILINEAR ACCESS DECODING
// ============================================================================

fn SMAADecodeDiagBilinearAccess_vec2(e: vec2<f32>) -> vec2<f32> {
    // Bilinear access for fetching 'e' have a 0.25 offset, and we are
    // interested in the R and G edges:
    //
    // +---G---+-------+
    // |   x o R   x   |
    // +-------+-------+
    //
    // Then, if one of these edge is enabled:
    //   Red:   (0.75 * X + 0.25 * 1) => 0.25 or 1.0
    //   Green: (0.75 * 1 + 0.25 * X) => 0.75 or 1.0
    //
    // This function will unpack the values (mad + mul + round):
    // wolframalpha.com: round(x * abs(5 * x - 5 * 0.75)) plot 0 to 1
    var result = e;
    result.r = e.r * abs(5.0 * e.r - 5.0 * 0.75);
    return round(result);
}

fn SMAADecodeDiagBilinearAccess_vec4(e: vec4<f32>) -> vec4<f32> {
    var result = e;
    result.r = e.r * abs(5.0 * e.r - 5.0 * 0.75);
    result.b = e.b * abs(5.0 * e.b - 5.0 * 0.75);
    return round(result);
}

// ============================================================================
// DIAGONAL PATTERN SEARCH FUNCTIONS
// ============================================================================

fn SMAASearchDiag1(
    edgesTex: texture_2d<f32>,
    edgesSampler: sampler,
    texcoord: vec2<f32>,
    dir: vec2<f32>,
    texelSize: vec2<f32>,
    end: ptr<function, vec2<f32>>
) -> vec2<f32> {
    var coord = vec4<f32>(texcoord, -1.0, 1.0);
    let t = vec3<f32>(texelSize, 1.0);
    
    for (var i = 0; i < i32(blendParams.maxSearchStepsDiag); i++) {
        if (!(coord.z < f32(blendParams.maxSearchStepsDiag - 1) && coord.w > 0.9)) { break; }
        coord = vec4<f32>(mad_vec2(t.xy, dir, coord.xy), mad_f32(t.z, 1.0, coord.z), coord.w);
        let e = textureSampleLevel(edgesTex, edgesSampler, coord.xy, 0.0).rg;
        coord.w = dot(e, vec2<f32>(0.5, 0.5));
        *end = e;
    }
    
    return coord.zw;
}

fn SMAASearchDiag2(
    edgesTex: texture_2d<f32>,
    edgesSampler: sampler,
    texcoord: vec2<f32>,
    dir: vec2<f32>,
    texelSize: vec2<f32>,
    end: ptr<function, vec2<f32>>
) -> vec2<f32> {
    var coord = vec4<f32>(texcoord, -1.0, 1.0);
    coord.x += 0.25 * texelSize.x;
    let t = vec3<f32>(texelSize, 1.0);
    
    for (var i = 0; i < i32(blendParams.maxSearchStepsDiag); i++) {
        if (!(coord.z < f32(blendParams.maxSearchStepsDiag - 1) && coord.w > 0.9)) { break; }
        coord = vec4<f32>(mad_vec2(t.xy, dir, coord.xy), mad_f32(t.z, 1.0, coord.z), coord.w);
        
        // @SearchDiag2Optimization
        // Fetch both edges at once using bilinear filtering:
        var e = textureSampleLevel(edgesTex, edgesSampler, coord.xy, 0.0).rg;
        e = SMAADecodeDiagBilinearAccess_vec2(e);
        
        coord.w = dot(e, vec2<f32>(0.5, 0.5));
        *end = e;
    }
    
    return coord.zw;
}

// ============================================================================
// AREA LOOKUP FUNCTIONS
// ============================================================================

fn SMAAAreaDiag(
    areaTex: texture_2d<f32>,
    areaSampler: sampler,
    dist: vec2<f32>,
    e: vec2<f32>,
    offset: f32
) -> vec2<f32> {
    var texcoord = mad_vec2(vec2<f32>(SMAA_AREATEX_MAX_DISTANCE_DIAG), e, dist);
    
    // We do a scale and bias for mapping to texel space:
    texcoord = mad_vec2(SMAA_AREATEX_PIXEL_SIZE, texcoord, 0.5 * SMAA_AREATEX_PIXEL_SIZE);
    
    // Diagonal areas are on the second half of the texture:
    texcoord.x += 0.5;
    
    // Move to proper place, according to the subpixel offset:
    texcoord.y += SMAA_AREATEX_SUBTEX_SIZE * offset;

    return textureSampleLevel(areaTex, areaSampler, texcoord, 0.0).rg;
}

fn SMAAArea(
    areaTex: texture_2d<f32>,
    areaSampler: sampler,
    dist: vec2<f32>,
    e1: f32,
    e2: f32,
    offset: f32
) -> vec2<f32> {
    // Rounding prevents precision errors of bilinear filtering:
    var texcoord = mad_vec2(vec2<f32>(SMAA_AREATEX_MAX_DISTANCE), round(4.0 * vec2<f32>(e1, e2)), dist);
    
    // We do a scale and bias for mapping to texel space:
    texcoord = mad_vec2(SMAA_AREATEX_PIXEL_SIZE, texcoord, 0.5 * SMAA_AREATEX_PIXEL_SIZE);
    
    // Move to proper place, according to the subpixel offset:
    texcoord.y = mad_f32(SMAA_AREATEX_SUBTEX_SIZE, offset, texcoord.y);

    return textureSampleLevel(areaTex, areaSampler, texcoord, 0.0).rg;
}

// ============================================================================
// SEARCH LENGTH (using searchTex)
// ============================================================================

fn SMAASearchLength(
    searchTex: texture_2d<f32>,
    searchSampler: sampler,
    e: vec2<f32>,
    offset: f32
) -> f32 {
    // The texture is flipped vertically, with left and right cases taking half
    // of the space horizontally:
    var scale = SMAA_SEARCHTEX_SIZE * vec2<f32>(0.5, -1.0);
    var bias = SMAA_SEARCHTEX_SIZE * vec2<f32>(offset, 1.0);
    
    // Scale and bias to access texel centers:
    scale += vec2<f32>(-1.0, 1.0);
    bias += vec2<f32>(0.5, -0.5);
    
    // Convert from pixel coordinates to texcoords:
    // (We use SMAA_SEARCHTEX_PACKED_SIZE because the texture is cropped)
    scale *= 1.0 / SMAA_SEARCHTEX_PACKED_SIZE;
    bias *= 1.0 / SMAA_SEARCHTEX_PACKED_SIZE;
    
    // Lookup the search texture:
    return textureSampleLevel(searchTex, searchSampler, mad_vec2(scale, e, bias), 0.0).r;
}

// ============================================================================
// HORIZONTAL/VERTICAL SEARCH FUNCTIONS (2nd pass)
// ============================================================================

fn SMAASearchXLeft(
    edgesTex: texture_2d<f32>,
    edgesSampler: sampler,
    searchTex: texture_2d<f32>,
    searchSampler: sampler,
    texcoord: vec2<f32>,
    end: f32,
    texelSize: vec2<f32>
) -> f32 {
    // PSEUDO_GATHER4
    // This texcoord has been offset by (-0.25, -0.125) in the vertex shader to
    // sample between edge, thus fetching four edges in a row.
    var tc = texcoord;
    var e = vec2<f32>(0.0, 1.0);
    
    for (var i = 0; i < i32(blendParams.maxSearchSteps); i++) {
        if (!(tc.x > end && e.g > 0.8281 && e.r == 0.0)) { break; }
        e = textureSampleLevel(edgesTex, edgesSampler, tc, 0.0).rg;
        tc = mad_vec2(-vec2<f32>(2.0, 0.0), texelSize, tc);
    }
    
    let offset = mad_f32(-(255.0 / 127.0), SMAASearchLength(searchTex, searchSampler, e, 0.0), 3.25);
    return mad_f32(texelSize.x, offset, tc.x);
}

fn SMAASearchXRight(
    edgesTex: texture_2d<f32>,
    edgesSampler: sampler,
    searchTex: texture_2d<f32>,
    searchSampler: sampler,
    texcoord: vec2<f32>,
    end: f32,
    texelSize: vec2<f32>
) -> f32 {
    var tc = texcoord;
    var e = vec2<f32>(0.0, 1.0);
    
    for (var i = 0; i < i32(blendParams.maxSearchSteps); i++) {
        if (!(tc.x < end && e.g > 0.8281 && e.r == 0.0)) { break; }
        e = textureSampleLevel(edgesTex, edgesSampler, tc, 0.0).rg;
        tc = mad_vec2(vec2<f32>(2.0, 0.0), texelSize, tc);
    }
    
    let offset = mad_f32(-(255.0 / 127.0), SMAASearchLength(searchTex, searchSampler, e, 0.5), 3.25);
    return mad_f32(-texelSize.x, offset, tc.x);
}

fn SMAASearchYUp(
    edgesTex: texture_2d<f32>,
    edgesSampler: sampler,
    searchTex: texture_2d<f32>,
    searchSampler: sampler,
    texcoord: vec2<f32>,
    end: f32,
    texelSize: vec2<f32>
) -> f32 {
    var tc = texcoord;
    var e = vec2<f32>(1.0, 0.0);
    
    for (var i = 0; i < i32(blendParams.maxSearchSteps); i++) {
        if (!(tc.y > end && e.r > 0.8281 && e.g == 0.0)) { break; }
        e = textureSampleLevel(edgesTex, edgesSampler, tc, 0.0).rg;
        tc = mad_vec2(-vec2<f32>(0.0, 2.0), texelSize, tc);
    }
    
    let offset = mad_f32(-(255.0 / 127.0), SMAASearchLength(searchTex, searchSampler, e.gr, 0.0), 3.25);
    return mad_f32(texelSize.y, offset, tc.y);
}

fn SMAASearchYDown(
    edgesTex: texture_2d<f32>,
    edgesSampler: sampler,
    searchTex: texture_2d<f32>,
    searchSampler: sampler,
    texcoord: vec2<f32>,
    end: f32,
    texelSize: vec2<f32>
) -> f32 {
    var tc = texcoord;
    var e = vec2<f32>(1.0, 0.0);
    
    for (var i = 0; i < i32(blendParams.maxSearchSteps); i++) {
        if (!(tc.y < end && e.r > 0.8281 && e.g == 0.0)) { break; }
        e = textureSampleLevel(edgesTex, edgesSampler, tc, 0.0).rg;
        tc = mad_vec2(vec2<f32>(0.0, 2.0), texelSize, tc);
    }
    
    let offset = mad_f32(-(255.0 / 127.0), SMAASearchLength(searchTex, searchSampler, e.gr, 0.5), 3.25);
    return mad_f32(-texelSize.y, offset, tc.y);
}

// ============================================================================
// DIAGONAL WEIGHTS CALCULATION
// ============================================================================

fn SMAACalculateDiagWeights(
    edgesTex: texture_2d<f32>,
    edgesSampler: sampler,
    areaTex: texture_2d<f32>,
    areaSampler: sampler,
    texcoord: vec2<f32>,
    e: vec2<f32>,
    subsampleIndices: vec4<f32>,
    texelSize: vec2<f32>
) -> vec2<f32> {
    var weights = vec2<f32>(0.0);
    
    // Search for the line ends:
    var d: vec4<f32>;
    var end = vec2<f32>(0.0);
    var temp: vec2<f32>;
    
    if (e.r > 0.0) {
        temp = SMAASearchDiag1(edgesTex, edgesSampler, texcoord, vec2<f32>(-1.0, 1.0), texelSize, &end);
        d.x = temp.x;
        d.z = temp.y;
        d.x += select(0.0, 1.0, end.y > 0.9);
    } else {
        d.x = 0.0;
        d.z = 0.0;
    }
    
    temp = SMAASearchDiag1(edgesTex, edgesSampler, texcoord, vec2<f32>(1.0, -1.0), texelSize, &end);
    d.y = temp.x;
    d.w = temp.y;
    
    if (d.x + d.y > 2.0) { // d.x + d.y + 1 > 3
        // Fetch the crossing edges:
        let coords = mad_vec4(vec4<f32>(-d.x + 0.25, d.x, d.y, -d.y - 0.25), vec4<f32>(texelSize.xy, texelSize.xy), texcoord.xyxy);
        var c: vec4<f32>;
        let temp_xy = SMAASampleLevelZeroOffset(edgesTex, edgesSampler, coords.xy, vec2<i32>(-1, 0), texelSize).rg;
        c.x = temp_xy.x;
        c.y = temp_xy.y;
        let temp_zw = SMAASampleLevelZeroOffset(edgesTex, edgesSampler, coords.zw, vec2<i32>(1, 0), texelSize).rg;
        c.z = temp_zw.x;
        c.w = temp_zw.y;
        c = vec4<f32>(c.y, c.x, c.w, c.z); // c.yxwz swizzle
        c = SMAADecodeDiagBilinearAccess_vec4(c);
        
        // Merge crossing edges at each side into a single value:
        var cc = mad_vec2(vec2<f32>(2.0), c.xz, c.yw);
        
        // Remove the crossing edge if we didn't found the end of the line:
        SMAAMovc_vec2(vec2<bool>(d.z >= 0.9, d.w >= 0.9), &cc, vec2<f32>(0.0));
        
        // Fetch the areas for this line:
        weights += SMAAAreaDiag(areaTex, areaSampler, d.xy, cc, subsampleIndices.z);
    }
    
    // Search for the line ends:
    temp = SMAASearchDiag2(edgesTex, edgesSampler, texcoord, vec2<f32>(-1.0, -1.0), texelSize, &end);
    d.x = temp.x;
    d.z = temp.y;
    
    if (SMAASampleLevelZeroOffset(edgesTex, edgesSampler, texcoord, vec2<i32>(1, 0), texelSize).r > 0.0) {
        temp = SMAASearchDiag2(edgesTex, edgesSampler, texcoord, vec2<f32>(1.0, 1.0), texelSize, &end);
        d.y = temp.x;
        d.w = temp.y;
        d.y += select(0.0, 1.0, end.y > 0.9);
    } else {
        d.y = 0.0;
        d.w = 0.0;
    }
    
    if (d.x + d.y > 2.0) { // d.x + d.y + 1 > 3
        // Fetch the crossing edges:
        let coords = mad_vec4(vec4<f32>(-d.x, -d.x, d.y, d.y), vec4<f32>(texelSize.xy, texelSize.xy), texcoord.xyxy);
        var c: vec4<f32>;
        c.x = SMAASampleLevelZeroOffset(edgesTex, edgesSampler, coords.xy, vec2<i32>(-1, 0), texelSize).g;
        c.y = SMAASampleLevelZeroOffset(edgesTex, edgesSampler, coords.xy, vec2<i32>(0, -1), texelSize).r;
        let temp_c = SMAASampleLevelZeroOffset(edgesTex, edgesSampler, coords.zw, vec2<i32>(1, 0), texelSize).gr;
        c.z = temp_c.x;
        c.w = temp_c.y;
        var cc = mad_vec2(vec2<f32>(2.0), c.xz, c.yw);
        
        // Remove the crossing edge if we didn't found the end of the line:
        SMAAMovc_vec2(vec2<bool>(d.z >= 0.9, d.w >= 0.9), &cc, vec2<f32>(0.0));
        
        // Fetch the areas for this line:
        weights += SMAAAreaDiag(areaTex, areaSampler, d.xy, cc, subsampleIndices.w).gr;
    }
    
    return weights;
}

// ============================================================================
// CORNER DETECTION FUNCTIONS
// ============================================================================

fn SMAADetectHorizontalCornerPattern(
    edgesTex: texture_2d<f32>,
    edgesSampler: sampler,
    weights: ptr<function, vec2<f32>>,
    texcoord: vec4<f32>,
    d: vec2<f32>,
    texelSize: vec2<f32>
) {
    // This can be disabled with SMAA_DISABLE_CORNER_DETECTION
    let leftRight = step(d.xy, d.yx);
    // CRITICAL: Normalize cornerRounding (divide by 100) to match GLSL implementation
    var rounding = (1.0 - blendParams.cornerRounding / 100.0) * leftRight;
    
    rounding /= leftRight.x + leftRight.y; // Reduce blending for pixels in the center of a line.
    
    var factor = vec2<f32>(1.0);
    factor.x -= rounding.x * SMAASampleLevelZeroOffset(edgesTex, edgesSampler, texcoord.xy, vec2<i32>(0, 1), texelSize).r;
    factor.x -= rounding.y * SMAASampleLevelZeroOffset(edgesTex, edgesSampler, texcoord.zw, vec2<i32>(1, 1), texelSize).r;
    factor.y -= rounding.x * SMAASampleLevelZeroOffset(edgesTex, edgesSampler, texcoord.xy, vec2<i32>(0, -2), texelSize).r;
    factor.y -= rounding.y * SMAASampleLevelZeroOffset(edgesTex, edgesSampler, texcoord.zw, vec2<i32>(1, -2), texelSize).r;
    
    *weights *= saturate(factor);
}

fn SMAADetectVerticalCornerPattern(
    edgesTex: texture_2d<f32>,
    edgesSampler: sampler,
    weights: ptr<function, vec2<f32>>,
    texcoord: vec4<f32>,
    d: vec2<f32>,
    texelSize: vec2<f32>
) {
    // This can be disabled with SMAA_DISABLE_CORNER_DETECTION
    let leftRight = step(d.xy, d.yx);
    // CRITICAL: Normalize cornerRounding (divide by 100) to match GLSL implementation
    var rounding = (1.0 - blendParams.cornerRounding / 100.0) * leftRight;
    
    rounding /= leftRight.x + leftRight.y;
    
    var factor = vec2<f32>(1.0);
    factor.x -= rounding.x * SMAASampleLevelZeroOffset(edgesTex, edgesSampler, texcoord.xy, vec2<i32>(1, 0), texelSize).g;
    factor.x -= rounding.y * SMAASampleLevelZeroOffset(edgesTex, edgesSampler, texcoord.zw, vec2<i32>(1, 1), texelSize).g;
    factor.y -= rounding.x * SMAASampleLevelZeroOffset(edgesTex, edgesSampler, texcoord.xy, vec2<i32>(-2, 0), texelSize).g;
    factor.y -= rounding.y * SMAASampleLevelZeroOffset(edgesTex, edgesSampler, texcoord.zw, vec2<i32>(-2, 1), texelSize).g;
    
    *weights *= saturate(factor);
}
