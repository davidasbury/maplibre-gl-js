// Equal Earth (EPSG:8857) projection chunk. Same entry-point contract as
// _projection_mercator.vertex.glsl. Tiles are mercator-addressed under every
// projection, so each vertex goes: tile pos -> mercator 0..1 -> lng/lat ->
// Equal Earth forward polynomial (Savric, Patterson & Jenny 2018). The
// polynomial must match src/geo/equal_earth_coordinate.ts exactly.
// PI and u_projection_matrix come from _prelude.vertex.glsl.

uniform highp vec4 u_projection_tile_mercator_coords;

// const float rather than #define: the shader minifier in
// build/generate-shaders.ts merges newlines after ")" into the next line,
// which would extend a parenthesized macro body over the following statement.
const float EE_A1 = 1.340264;
const float EE_A2 = -0.081106;
const float EE_A3 = 0.000893;
const float EE_A4 = 0.003796;
const float EE_M = sqrt(3.0) / 2.0;

float projectLineThickness(float tileY) {
    // Known Stage-A defect, deferred deliberately: Equal Earth line thickness
    // should scale with latitude (compare globe's projectLineThickness).
    return 1.0;
}

float projectCircleRadius(float tileY) {
    // Known Stage-A defect, deferred deliberately: same latitude-dependent
    // scaling gap as projectLineThickness.
    return 1.0;
}

// Consider this private. Computes the Equal Earth position of a vertex in the
// paper's y-up convention on the unit sphere (radius 1), matching
// equalEarthXYFromLngLat on the CPU.
vec2 projectToEqualEarth(vec2 posInTile, vec2 rawPos) {
    // Compute position in range 0..1 of the base tile of web mercator
    vec2 mercator_pos = u_projection_tile_mercator_coords.xy + u_projection_tile_mercator_coords.zw * posInTile;

    // Inverse web mercator. Latitude is the same formula globe's
    // projectToSphere uses. Longitude must be mercator_x * 2PI - PI here, NOT
    // globe's "+ PI": globe only feeds lambda into sin/cos (2PI-periodic),
    // while the Equal Earth polynomial uses lambda linearly.
    float lng = mercator_pos.x * PI * 2.0 - PI;
    float lat = 2.0 * atan(exp(PI - (mercator_pos.y * PI * 2.0))) - PI * 0.5;

    // Pole sentinel vertices (NORTH_POLE_Y/SOUTH_POLE_Y in
    // render/subdivision.ts; globe's projectToSphere maps rawPos.y < -32767.5
    // to the north pole). Where mercator's shader kills these vertices, Equal
    // Earth renders them: its poles are lines, x still varies with longitude
    // there (cos(paramLat) != 0), so pole vertices draw the flat top/bottom
    // edges of the projection outline.
    if (rawPos.y < -32767.5) {
        lat = PI * 0.5;
    }
    if (rawPos.y > 32766.5) {
        lat = -PI * 0.5;
    }

    float paramLat = asin(EE_M * sin(lat));
    float paramLatSq = paramLat * paramLat;
    float paramLatPow6 = paramLatSq * paramLatSq * paramLatSq;

    float x = lng * cos(paramLat) /
        (EE_M * (EE_A1 + 3.0 * EE_A2 * paramLatSq + paramLatPow6 * (7.0 * EE_A3 + 9.0 * EE_A4 * paramLatSq)));
    float y = paramLat * (EE_A1 + EE_A2 * paramLatSq + paramLatPow6 * (EE_A3 + EE_A4 * paramLatSq));

    return vec2(x, y);
}

// Projects a point in tile-local coordinates (usually 0..EXTENT) to screen,
// and handles special pole vertices (rendered, not killed -- see above).
// The y negation is the one GPU-side crossing of the paper-y-up ->
// world-y-down seam, mirroring equal_earth_utils.ts on the CPU:
// u_projection_matrix (the equalEarthMatrix) consumes y-down unit
// Equal Earth coordinates.
vec4 projectTile(vec2 p, vec2 rawPos) {
    vec2 ee = projectToEqualEarth(p, rawPos);
    return u_projection_matrix * vec4(ee.x, -ee.y, 0.0, 1.0);
}

// Projects a point in tile-local coordinates (usually 0..EXTENT) to screen.
vec4 projectTile(vec2 p) {
    // vec2(0.0) is never in the pole sentinel range.
    return projectTile(p, vec2(0.0, 0.0));
}

vec4 projectTileWithElevation(vec2 posInTile, float elevation) {
    // Like mercator: only used in symbol vertex shaders and symbols never use
    // pole vertices, so no sentinel detection. Elevation passes through as z
    // (unused in Demo A).
    vec2 ee = projectToEqualEarth(posInTile, vec2(0.0, 0.0));
    return u_projection_matrix * vec4(ee.x, -ee.y, elevation, 1.0);
}

vec4 projectTileFor3D(vec2 posInTile, float elevation) {
    // Like mercator: no special Z handling for a flat projection, so this is
    // the same function as projectTileWithElevation.
    return projectTileWithElevation(posInTile, elevation);
}
