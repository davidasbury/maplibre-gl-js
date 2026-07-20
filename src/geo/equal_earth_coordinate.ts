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
