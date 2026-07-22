// Equal Earth (EPSG:8857) projection chunk. Same entry-point contract as
// _projection_mercator.vertex.glsl. Tiles are mercator-addressed under every
// projection, so each vertex goes: tile pos -> mercator 0..1 -> lng/lat ->
// Equal Earth forward polynomial (Savric, Patterson & Jenny 2018). The
// polynomial must match src/geo/equal_earth_coordinate.ts exactly.
// PI and u_projection_matrix come from _prelude.vertex.glsl.

uniform highp vec4 u_projection_tile_mercator_coords;
// Per-tile linearized path (f32 round 2, 2026-07-22): above the transform's
// linearization threshold the CPU sends a per-tile tile-units -> clip matrix
// (f64-composed, f32-cast -- the mercator posMatrix trick) in
// u_projection_matrix plus two small clip-space quadratic-correction vectors,
// and signals the mode by u_projection_tile_mercator_coords.zw == 0 (a real
// tile always has a positive mercator span; the tile-less placeholder is
// [0,0,1,1]). Rationale: the polynomial path stores absolute unit-world EE
// coordinates (~0.5) in f32, whose ulp is ~2^-24 of the world -- 8 screen px
// at z18 -- so any sub-ulp geometry (line extrusions, small buildings)
// collapses; weaker shader ALUs (Haswell) lose further bits in the
// transcendentals and degrade from ~z13.5. Tile-local coordinates are
// f32-exact, so the linear path has neither failure mode. Linearizing EE per
// tile is near-exact: x is exactly linear in lambda (pseudocylindrical), and
// the residual after the quadratic terms is third-order in the tile span
// (CPU-side eligibility keeps it below 0.05 px). Pole-row tiles are excluded
// CPU-side, so the pole sentinel branch below never meets this path.
uniform highp vec4 u_projection_ee_quad_uv;
uniform highp vec4 u_projection_ee_quad_vv;

bool eeLinearizedMode() {
    return u_projection_tile_mercator_coords.z == 0.0;
}

// const float rather than #define: the shader minifier in
// build/generate-shaders.ts merges newlines after ")" into the next line,
// which would extend a parenthesized macro body over the following statement.
const float EE_A1 = 1.340264;
const float EE_A2 = -0.081106;
const float EE_A3 = 0.000893;
const float EE_A4 = 0.003796;
const float EE_M = sqrt(3.0) / 2.0;
// Full paper-unit width of the Equal Earth world: 2 * 2.7066299836960748
// (EQUAL_EARTH_WORLD_EXTENT in equal_earth_coordinate.ts). Full float64
// digits kept in source; GLSL truncates to float32 precision, which is
// fine/unavoidable GPU-side.
const float EE_WORLD_EXTENT = 5.4132599673921497;

// sqrt(G): EE-vs-mercator area-scale ratio at the equator
// (EQUAL_EARTH_SQRT_AREA_RATIO in equal_earth_coordinate.ts — derived
// there from the projection constants; pinned equal by a unit test).
const float EE_SQRT_AREA_RATIO = 1.1607026718;
// Thickness cap: EE renders latitudes mercator data never carries
// (beyond ±85.05°, e.g. client GeoJSON to ±90) where cos(lat) → 0 and
// the correction would blow up; 8× is far beyond any sane line width
// growth and keeps pole-line geometry finite.
const float EE_MAX_THICKNESS_CORRECTION = 8.0;

// Geometric-mean thickness correction for symbolization extruded in
// mercator tile units (Stage B cleanup item 3; replaces the Stage-A 1.0
// stubs). Equal-area gives sx(φ)·sy(φ) = G·cos²(φ) exactly, so the
// minimax scalar over line directions is 1/(sqrt(G)·cos φ) — the analog
// of globe's 1/cos(lat), which is exact for globe only because mercator
// → sphere is conformal; EE is not, so ±16–30% direction-dependent
// residual anisotropy is inherent and accepted.
// In linearized mode the mercator y is unavailable in-shader (zw == 0
// sentinel); the CPU folds the per-tile constant correction into
// u_projection_tile_mercator_coords.x instead (negligible variation
// across a high-zoom tile).
float eeThicknessCorrectionAtTileY(float tileY) {
    if (eeLinearizedMode()) {
        return u_projection_tile_mercator_coords.x;
    }
    float mercator_y = u_projection_tile_mercator_coords.y + u_projection_tile_mercator_coords.w * tileY;
    float lat = 2.0 * atan(exp(PI - (mercator_y * PI * 2.0))) - PI * 0.5;
    return min(1.0 / (EE_SQRT_AREA_RATIO * cos(lat)), EE_MAX_THICKNESS_CORRECTION);
}

float projectLineThickness(float tileY) {
    // REVERTED to 1.0 after owner review (2026-07-22): the geometric-mean
    // correction made graticule lines visibly widen toward the poles — a
    // look regression on the demo's face. The cartographic options (1.0 =
    // authored-width-in-tile-space, geometric mean = minimax over
    // directions, per-direction = impossible for a scalar) are recorded in
    // the design proposal for an upstream decision; circles keep the
    // area-true correction below.
    return 1.0;
}

float projectCircleRadius(float tileY) {
    return eeThicknessCorrectionAtTileY(tileY);
}

// Consider this private. Computes the Equal Earth position of a vertex as
// unit-square world coordinates -- (0.5, 0.5) = (0, 0) degrees, y-down --
// matching equalEarthWorldFromLngLat on the CPU: the paper-convention
// forward polynomial normalized by EE_WORLD_EXTENT with the y-flip folded
// in. Not paper coordinates.
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

    return vec2(x / EE_WORLD_EXTENT + 0.5, 0.5 - y / EE_WORLD_EXTENT);
}

// The high-zoom linearized path: u_projection_matrix is the per-tile
// tile-units -> clip matrix; the two quadratic terms restore the (tiny)
// curvature the affine part drops. All per-vertex values here are either
// tile-local (f32-exact) or pixel-scale (no cancellation).
vec4 projectTileLinearized(vec2 p, float elevation) {
    vec4 pos = u_projection_matrix * vec4(p.x, p.y, elevation, 1.0);
    return pos + u_projection_ee_quad_uv * (p.x * p.y) + u_projection_ee_quad_vv * (p.y * p.y);
}

// Projects a point in tile-local coordinates (usually 0..EXTENT) to screen,
// and handles special pole vertices (rendered, not killed -- see above).
// projectToEqualEarth already returns unit-square y-down world coordinates,
// which is exactly what u_projection_matrix (the equalEarthMatrix) consumes
// in the polynomial mode; in linearized mode u_projection_matrix is the
// per-tile matrix instead and the polynomial never runs.
vec4 projectTile(vec2 p, vec2 rawPos) {
    if (eeLinearizedMode()) {
        // Linearized tiles are never pole-row tiles (CPU-side eligibility),
        // so rawPos sentinels cannot occur here.
        return projectTileLinearized(p, 0.0);
    }
    vec2 ee = projectToEqualEarth(p, rawPos);
    return u_projection_matrix * vec4(ee.x, ee.y, 0.0, 1.0);
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
    if (eeLinearizedMode()) {
        return projectTileLinearized(posInTile, elevation);
    }
    vec2 ee = projectToEqualEarth(posInTile, vec2(0.0, 0.0));
    return u_projection_matrix * vec4(ee.x, ee.y, elevation, 1.0);
}

vec4 projectTileFor3D(vec2 posInTile, float elevation) {
    // Like mercator: no special Z handling for a flat projection, so this is
    // the same function as projectTileWithElevation.
    return projectTileWithElevation(posInTile, elevation);
}
