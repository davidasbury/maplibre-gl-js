import {clamp, degreesToRadians, radiansToDegrees} from '../util/util.ts';

/**
 * Equal Earth projection (EPSG:8857) forward and inverse math, in the same
 * spirit as `mercator_coordinate.ts`: plain functions operating on
 * dimensionless unit-sphere (radius 1) coordinates, not meters — world-size
 * scaling is applied elsewhere. `equalEarthXYFromLngLat`/`lngLatFromEqualEarthXY`
 * (the paper-convention pair) have no central meridian concept at all — they
 * always treat `lng` as the value to feed the polynomial directly. Central
 * meridian (λ0) lives one level up, in `equalEarthWorldFromLngLat`/
 * `lngLatFromEqualEarthWorld` (Stage B step 8 — see the design doc below).
 *
 * Forward polynomial and Newton-iteration inverse follow:
 * Šavrič, B., Patterson, T., & Jenny, B. (2018). The Equal Earth map
 * projection. International Journal of Geographical Information Science.
 * https://doi.org/10.1080/13658816.2018.1504949
 *
 * λ0 support (Stage B step 8): see
 * docs/resources/2026-07-20-stage-b-step8-dynamic-lambda0-design.md (outer
 * project) for the full design. Summary: λ0 ≡ center.lng everywhere, so
 * "world coordinates" become λ0-relative (`Δλ = lng − λ0`); the render path
 * (shader + `getProjectionData`) never calls these functions and instead
 * folds the equivalent shift in on the CPU per-tile (see
 * `equal_earth_transform.ts#getProjectionData`) — these functions carry the
 * λ0 math only for CPU consumers (picking, camera placement, constrain).
 */

const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;

export function equalEarthXYFromLngLat(lng: number, lat: number): {x: number; y: number} {
    const lam = degreesToRadians(lng);
    const phi = degreesToRadians(lat);

    const paramLat = Math.asin(M * Math.sin(phi));
    const paramLatSq = paramLat * paramLat;
    const paramLatPow6 = paramLatSq * paramLatSq * paramLatSq;

    const x = lam * Math.cos(paramLat) /
        (M * (A1 + 3 * A2 * paramLatSq + paramLatPow6 * (7 * A3 + 9 * A4 * paramLatSq)));
    const y = paramLat * (A1 + A2 * paramLatSq + paramLatPow6 * (A3 + A4 * paramLatSq));

    return {x, y};
}

const maxNewtonIterations = 12;
const newtonConvergenceEpsilon = 1e-9;

/**
 * Shared Newton iteration: paper-space y is a function of φ (via `paramLat`)
 * alone — Equal Earth is pseudocylindrical, so latitude never depends on x/λ.
 * Extracted so `lngLatFromEqualEarthXY` (needs paramLat, then also recovers
 * λ from x) and `latFromEqualEarthWorldY` (needs only paramLat → φ, no x/λ
 * involved at all) share one implementation instead of two copies of the
 * same loop.
 */
function paramLatFromPaperY(y: number): number {
    let paramLat = y;

    for (let i = 0; i < maxNewtonIterations; i++) {
        const paramLatSq = paramLat * paramLat;
        const paramLatPow6 = paramLatSq * paramLatSq * paramLatSq;
        const fy = paramLat * (A1 + A2 * paramLatSq + paramLatPow6 * (A3 + A4 * paramLatSq)) - y;
        const fPrimeY = A1 + 3 * A2 * paramLatSq + paramLatPow6 * (7 * A3 + 9 * A4 * paramLatSq);
        const delta = fy / fPrimeY;
        paramLat -= delta;
        if (Math.abs(delta) < newtonConvergenceEpsilon) {
            break;
        }
    }

    return paramLat;
}

export function lngLatFromEqualEarthXY(x: number, y: number): {lng: number; lat: number} {
    const paramLat = paramLatFromPaperY(y);
    const paramLatSq = paramLat * paramLat;
    const paramLatPow6 = paramLatSq * paramLatSq * paramLatSq;
    const lam = M * x * (A1 + 3 * A2 * paramLatSq + paramLatPow6 * (7 * A3 + 9 * A4 * paramLatSq)) / Math.cos(paramLat);
    // At exact poles, float rounding can push sin(paramLat) / M fractionally
    // above 1. proj4's own eqearth.js calls asin() on that unclamped and
    // returns NaN latitude there; clamping keeps this finite and correct.
    const phi = Math.asin(clamp(Math.sin(paramLat) / M, -1, 1));

    return {lng: radiansToDegrees(lam), lat: radiansToDegrees(phi)};
}

/**
 * ∂(x_paper)/∂λ at a given latitude, i.e. the "k(φ)" scale factor from the
 * design doc's "banana tiling" note, in unit-square-per-degree terms (the
 * chain includes both the radians-per-degree factor and the
 * `EQUAL_EARTH_WORLD_EXTENT` normalization `equalEarthWorldFromLngLat` uses).
 * Equal Earth is pseudocylindrical — `x_paper(λ,φ) = λ · k(φ)`, independent
 * of λ — so this slope is exact, not a finite-difference approximation, and
 * depends only on latitude (via the same `paramLat` substitution as the
 * forward/inverse functions above). Used by
 * `EqualEarthTransform.setLocationAtPoint`'s closed-form λ0 solve.
 * @param lat - Latitude in degrees.
 * @returns unit worldX per degree of Δλ at that latitude. Always > 0 (no
 * singularity — EE's poles are lines, not points).
 */
export function equalEarthXScaleAtLat(lat: number): number {
    const phi = degreesToRadians(lat);
    const paramLat = Math.asin(M * Math.sin(phi));
    const paramLatSq = paramLat * paramLat;
    const paramLatPow6 = paramLatSq * paramLatSq * paramLatSq;
    const dxPaperDLamRadians = Math.cos(paramLat) /
        (M * (A1 + 3 * A2 * paramLatSq + paramLatPow6 * (7 * A3 + 9 * A4 * paramLatSq)));
    return dxPaperDLamRadians * (Math.PI / 180) / EQUAL_EARTH_WORLD_EXTENT;
}

/**
 * Full paper-unit width of the Equal Earth world: 2 × x at λ=180°, φ=0.
 * One uniform divisor for both axes preserves the equal-area shape; world-y
 * therefore spans only ~[0.2566, 0.7434] of the unit square, deliberately.
 */
export const EQUAL_EARTH_WORLD_EXTENT: number = 2 * 2.7066299836960748;

/**
 * Forward Equal Earth projection into the engine's fraction-of-world
 * unit-square convention (the analogue of `MercatorCoordinate`'s unit world):
 * (0.5, 0.5) is (λ0, 0°), x=1 is λ0+180° on the equator, and y grows
 * southward (y-down). This function and `lngLatFromEqualEarthWorld` carry the
 * *entire* world convention — the `EQUAL_EARTH_WORLD_EXTENT` scale and the
 * y-flip — so callers never hand-roll either.
 *
 * `lambda0` (Stage B step 8) is the central meridian, always ≡ `center.lng`
 * at the call sites that matter (see the design doc) — this function itself
 * stays a pure, centerless function of its three arguments, default 0 so
 * every pre-Stage-B call site (and its pinned tests) keeps working unchanged.
 *
 * `Δλ = lng − lambda0` is used RAW, deliberately NOT wrapped to a shortest
 * arc, despite the design doc suggesting shortest-arc wrapping here: wrapping
 * would break `locationToScreenPoint`'s ability to correctly place a point
 * that legitimately belongs on a rendered world copy other than the primary
 * one (Δλ genuinely > 180 in magnitude — exactly what Mechanism 2 render
 * multi-copy support requires), and it broke an existing pinned test
 * (`equal_earth_covering_tiles.test.ts`'s antimeridian round-trip-bbox case)
 * that depends on this function staying continuous/unwrapped even for
 * slightly-out-of-range raw longitudes. The one place shortest-arc semantics
 * actually matters — `handleEaseTo`/`handleFlyTo` computing a short delta
 * between the current view and a possibly-far-in-raw-terms target — is
 * already handled upstream by `normalizeCenter` (`transform_helper.ts`),
 * which mutates the target center to within 180° of `tr.center.lng` before
 * these functions ever see it. See the design doc's Mechanism 1 section for
 * the originally proposed wrap and this comment for why it was dropped.
 */
export function equalEarthWorldFromLngLat(lng: number, lat: number, lambda0: number = 0): {x: number; y: number} {
    const deltaLng = lng - lambda0;
    const {x, y} = equalEarthXYFromLngLat(deltaLng, lat);
    return {
        x: x / EQUAL_EARTH_WORLD_EXTENT + 0.5,
        y: 0.5 - y / EQUAL_EARTH_WORLD_EXTENT
    };
}

/**
 * Inverse of `equalEarthWorldFromLngLat`: unit-square world coordinates
 * (y-down) back to lng/lat, undoing the scale and y-flip before entering the
 * paper-convention Newton inverse.
 *
 * Returns `lng = lambda0 + Δλ` UNWRAPPED (not re-wrapped into [-180, 180]):
 * the covering-tiles provider's geographic-bbox logic already documents and
 * depends on unwrapped longitude output (see
 * `equal_earth_covering_tiles_details_provider.ts`'s `GeoBBox` doc comment),
 * and `LngLat` itself doesn't restrict `lng`'s range, so there is no reason
 * to lose information here that a caller may need.
 */
export function lngLatFromEqualEarthWorld(x: number, y: number, lambda0: number = 0): {lng: number; lat: number} {
    const {lng: deltaLng, lat} = lngLatFromEqualEarthXY(
        (x - 0.5) * EQUAL_EARTH_WORLD_EXTENT,
        (0.5 - y) * EQUAL_EARTH_WORLD_EXTENT
    );
    return {lng: lambda0 + deltaLng, lat};
}

/**
 * World-y (unit-square, y-down) of the pole lines — the actual vertical
 * extent of Equal Earth content, deliberately derived from the forward
 * function itself rather than hardcoded (see the design doc's "zoom-dependent
 * constraint" section): pins against the same ~0.2566/0.7434 values the
 * existing "world-square normalization anchors" test fixes independently.
 * Used by `EqualEarthTransform.defaultConstrain`'s vertical clamp and
 * `setLocationAtPoint`'s y-clamp-before-inverting.
 */
export const EQUAL_EARTH_WORLD_Y_NORTH_POLE: number = equalEarthWorldFromLngLat(0, 90).y;
export const EQUAL_EARTH_WORLD_Y_SOUTH_POLE: number = equalEarthWorldFromLngLat(0, -90).y;

/**
 * y-only inverse: latitude as a function of unit world-y alone (Equal Earth
 * is pseudocylindrical — y never depends on x/λ0). Undoes the same scale +
 * y-flip as `lngLatFromEqualEarthWorld`, then reuses the shared Newton
 * iteration (`paramLatFromPaperY`) without ever computing a longitude. Used
 * by `EqualEarthTransform.setLocationAtPoint`'s closed-form λ0 solve (its
 * "vertical" step) and `defaultConstrain`'s vertical clamp — both need
 * latitude from a world-y they already have without caring about longitude.
 * @param y - Unit world-y (y-down; not required to be pre-clamped to the
 * pole-line range — callers that need that clamp do it themselves first).
 */
export function latFromEqualEarthWorldY(y: number): number {
    const paperY = (0.5 - y) * EQUAL_EARTH_WORLD_EXTENT;
    const paramLat = paramLatFromPaperY(paperY);
    const phi = Math.asin(clamp(Math.sin(paramLat) / M, -1, 1));
    return radiansToDegrees(phi);
}
