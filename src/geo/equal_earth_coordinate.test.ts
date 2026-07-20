import {describe, test, expect} from 'vitest';
import {equalEarthXYFromLngLat, lngLatFromEqualEarthXY} from './equal_earth_coordinate.ts';
import fixtures from './equal_earth_fixtures.json' with {type: 'json'};

const points = fixtures.points;
type FixturePoint = (typeof points)[number];

function requirePoint(lng: number, lat: number): FixturePoint {
    const point = points.find(p => p.lng === lng && p.lat === lat);
    if (!point) {
        throw new Error(`Fixture missing expected point lng=${lng}, lat=${lat}`);
    }
    return point;
}

function circularLngDiffDegrees(a: number, b: number): number {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

// Forward agreement with the proj4 reference is effectively bit-exact:
// observed max abs error across all 332 fixture points is 0 for x and
// ~4.2e-22 for y, so 1e-9 has enormous headroom.
const FORWARD_TOLERANCE = 1e-9;

// Inverse longitude recovers to ~1.1e-13 max abs error across all 332 points.
const INVERSE_LNG_TOLERANCE = 1e-9;

// Inverse latitude is the one place 1e-9 is not uniformly achievable: near
// the poles the Newton inverse's Jacobian is close to singular, and the
// observed max abs error across all 332 points is ~2.7298e-9, at the
// (lng=+-179.9999, lat=+-89.9999) edge-case points -- just short of the pole
// line itself, where the error is actually 0. 1e-8 covers the observed max
// with margin for transcendental-function differences across JS engines.
const INVERSE_LAT_TOLERANCE = 1e-8;

describe('equalEarthXYFromLngLat', () => {
    test('matches proj4 reference forward output for all 332 fixture points', () => {
        for (const p of points) {
            const {x, y} = equalEarthXYFromLngLat(p.lng, p.lat);
            expect(Math.abs(x - p.x)).toBeLessThanOrEqual(FORWARD_TOLERANCE);
            expect(Math.abs(y - p.y)).toBeLessThanOrEqual(FORWARD_TOLERANCE);
        }
    });

    test('pole point (lat=90)', () => {
        const p = requirePoint(0, 90);
        const {x, y} = equalEarthXYFromLngLat(p.lng, p.lat);
        expect(Math.abs(x - p.x)).toBeLessThanOrEqual(FORWARD_TOLERANCE);
        expect(Math.abs(y - p.y)).toBeLessThanOrEqual(FORWARD_TOLERANCE);
    });

    test('antimeridian point (lng=180)', () => {
        const p = requirePoint(180, 0);
        const {x, y} = equalEarthXYFromLngLat(p.lng, p.lat);
        expect(Math.abs(x - p.x)).toBeLessThanOrEqual(FORWARD_TOLERANCE);
        expect(Math.abs(y - p.y)).toBeLessThanOrEqual(FORWARD_TOLERANCE);
    });
});

describe('lngLatFromEqualEarthXY', () => {
    test('matches original lng/lat for all 332 fixture points', () => {
        for (const p of points) {
            const {lng, lat} = lngLatFromEqualEarthXY(p.x, p.y);
            expect(circularLngDiffDegrees(lng, p.lng)).toBeLessThanOrEqual(INVERSE_LNG_TOLERANCE);
            expect(Math.abs(lat - p.lat)).toBeLessThanOrEqual(INVERSE_LAT_TOLERANCE);
        }
    });

    test('pole point (lat=-90)', () => {
        const p = requirePoint(0, -90);
        const {lng, lat} = lngLatFromEqualEarthXY(p.x, p.y);
        expect(Number.isFinite(lat)).toBe(true);
        expect(circularLngDiffDegrees(lng, p.lng)).toBeLessThanOrEqual(INVERSE_LNG_TOLERANCE);
        expect(Math.abs(lat - p.lat)).toBeLessThanOrEqual(INVERSE_LAT_TOLERANCE);
    });

    test('antimeridian point (lng=-180)', () => {
        const p = requirePoint(-180, 0);
        const {lng, lat} = lngLatFromEqualEarthXY(p.x, p.y);
        expect(circularLngDiffDegrees(lng, p.lng)).toBeLessThanOrEqual(INVERSE_LNG_TOLERANCE);
        expect(Math.abs(lat - p.lat)).toBeLessThanOrEqual(INVERSE_LAT_TOLERANCE);
    });

    // Regression test for a bug in proj4's own eqearth.js that this
    // implementation must not inherit: its inverse computes
    // asin(sin(paramLat) / M) unclamped, and at exact poles float rounding
    // pushes that argument fractionally over 1, making JS's asin() return
    // NaN. Confirmed this fails (NaN) without the clamp before adding it;
    // this asserts it stays fixed.
    test('pole-clamp regression: inverse at a pole returns a finite, correct latitude', () => {
        const p = requirePoint(0, 90);
        const {lat} = lngLatFromEqualEarthXY(p.x, p.y);
        expect(Number.isFinite(lat)).toBe(true);
        expect(Math.abs(lat - 90)).toBeLessThanOrEqual(INVERSE_LAT_TOLERANCE);
    });
});
