import {clamp, degreesToRadians, radiansToDegrees} from '../util/util.ts';

/**
 * Equal Earth projection (EPSG:8857) forward and inverse math, in the same
 * spirit as `mercator_coordinate.ts`: plain functions operating on
 * dimensionless unit-sphere (radius 1) coordinates, not meters — world-size
 * scaling is applied elsewhere. Central meridian is fixed at 0.
 *
 * Forward polynomial and Newton-iteration inverse follow:
 * Šavrič, B., Patterson, T., & Jenny, B. (2018). The Equal Earth map
 * projection. International Journal of Geographical Information Science.
 * https://doi.org/10.1080/13658816.2018.1504949
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

export function lngLatFromEqualEarthXY(x: number, y: number): {lng: number; lat: number} {
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
 * Full paper-unit width of the Equal Earth world: 2 × x at λ=180°, φ=0.
 * One uniform divisor for both axes preserves the equal-area shape; world-y
 * therefore spans only ~[0.2566, 0.7434] of the unit square, deliberately.
 */
export const EQUAL_EARTH_WORLD_EXTENT: number = 2 * 2.7066299836960748;

/**
 * Forward Equal Earth projection into the engine's fraction-of-world
 * unit-square convention (the analogue of `MercatorCoordinate`'s unit world):
 * (0.5, 0.5) is (0°, 0°), x=1 is λ=180° on the equator, and y grows
 * southward (y-down). This function and `lngLatFromEqualEarthWorld` carry the
 * *entire* world convention — the `EQUAL_EARTH_WORLD_EXTENT` scale and the
 * y-flip — so callers never hand-roll either.
 */
export function equalEarthWorldFromLngLat(lng: number, lat: number): {x: number; y: number} {
    const {x, y} = equalEarthXYFromLngLat(lng, lat);
    return {
        x: x / EQUAL_EARTH_WORLD_EXTENT + 0.5,
        y: 0.5 - y / EQUAL_EARTH_WORLD_EXTENT
    };
}

/**
 * Inverse of `equalEarthWorldFromLngLat`: unit-square world coordinates
 * (y-down) back to lng/lat, undoing the scale and y-flip before entering the
 * paper-convention Newton inverse.
 */
export function lngLatFromEqualEarthWorld(x: number, y: number): {lng: number; lat: number} {
    return lngLatFromEqualEarthXY(
        (x - 0.5) * EQUAL_EARTH_WORLD_EXTENT,
        (0.5 - y) * EQUAL_EARTH_WORLD_EXTENT
    );
}
