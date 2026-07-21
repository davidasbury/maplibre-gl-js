import {describe, test, expect} from 'vitest';
import {
    equalEarthXYFromLngLat,
    lngLatFromEqualEarthXY,
    equalEarthWorldFromLngLat,
    lngLatFromEqualEarthWorld,
    equalEarthXScaleAtLat,
    latFromEqualEarthWorldY
} from './equal_earth_coordinate.ts';
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

// Stage B step 8: dynamic lambda0 (central meridian tracks center.lng). See
// docs/resources/2026-07-20-stage-b-step8-dynamic-lambda0-design.md (outer
// project) for the full design and test plan this section implements.
describe('equalEarthWorldFromLngLat / lngLatFromEqualEarthWorld (lambda0)', () => {
    test('lambda0 defaults to 0 and matches the pre-Stage-B behavior', () => {
        for (const p of points) {
            const withDefault = equalEarthWorldFromLngLat(p.lng, p.lat);
            const withExplicitZero = equalEarthWorldFromLngLat(p.lng, p.lat, 0);
            expect(withDefault.x).toBe(withExplicitZero.x);
            expect(withDefault.y).toBe(withExplicitZero.y);
        }
    });

    test('center-pin invariant: a point at lambda0 always lands at unit world x = 0.5', () => {
        for (const lambda0 of [0, 90, 180, -120]) {
            const {x, y} = equalEarthWorldFromLngLat(lambda0, 0, lambda0);
            expect(Math.abs(x - 0.5)).toBeLessThanOrEqual(1e-9);
            expect(Math.abs(y - 0.5)).toBeLessThanOrEqual(1e-9);
        }
    });

    test('fixed +-180-from-center anchors do not move when lambda0 changes (fixed outline)', () => {
        // Mirrors the transform-level "fixed outline" gate, but pins the pure
        // coordinate math directly: the world-x of center+-180 is identical
        // regardless of what center.lng (lambda0) actually is.
        for (const lambda0 of [0, 90, 180, -120]) {
            const east = equalEarthWorldFromLngLat(lambda0 + 180, 0, lambda0);
            const west = equalEarthWorldFromLngLat(lambda0 - 180, 0, lambda0);
            expect(Math.abs(east.x - 1.0)).toBeLessThanOrEqual(1e-9);
            expect(Math.abs(west.x - 0.0)).toBeLessThanOrEqual(1e-9);
        }
    });

    test('round trip holds exactly for lambda0 in {0, 90, 180}, including unwrapped lng beyond +-180', () => {
        // "Unwrapped lng beyond +-180" here means Δλ = lng - lambda0 exceeds
        // a hemisphere in raw magnitude. Since equalEarthWorldFromLngLat is
        // deliberately NOT shortest-arc-wrapped (see its doc comment -- a
        // Stage B step 8 deviation from the design doc, needed so
        // locationToScreenPoint can correctly place points on non-primary
        // world copies), the round trip is exact, not just circularly equal:
        // there is no lossy wrap step to undo.
        const testLocations = [
            {lng: 10, lat: 5},
            {lng: -170, lat: 40},
            {lng: 179.9, lat: -10},
            {lng: 300, lat: 20},
            {lng: -260, lat: -30},
        ];
        for (const lambda0 of [0, 90, 180]) {
            for (const {lng, lat} of testLocations) {
                const world = equalEarthWorldFromLngLat(lng, lat, lambda0);
                const roundTripped = lngLatFromEqualEarthWorld(world.x, world.y, lambda0);
                expect(roundTripped.lng).toBeCloseTo(lng, 6);
                expect(Math.abs(roundTripped.lat - lat)).toBeLessThanOrEqual(1e-6);
            }
        }
    });

    test('inverse returns unwrapped lng (lambda0 + deltaLng, not re-wrapped)', () => {
        // A point just past +180 from a lambda0=170 center: unwrapped lng is
        // 170 + 175 = 345, which the inverse must return as-is (not wrapped
        // down to -15), per the covering-tiles provider's documented
        // dependency on unwrapped longitude output.
        const lambda0 = 170;
        const world = equalEarthWorldFromLngLat(345, 0, lambda0);
        const {lng} = lngLatFromEqualEarthWorld(world.x, world.y, lambda0);
        expect(lng).toBeCloseTo(345, 6);
    });
});

describe('equalEarthXScaleAtLat', () => {
    // Pin against a central finite difference of the forward function at the
    // same latitude -- independent of the analytic derivation in the source.
    const FINITE_DIFF_H_DEGREES = 1e-4;
    const FINITE_DIFF_TOLERANCE = 1e-6;

    test('matches finite-difference slope of equalEarthWorldFromLngLat at several latitudes', () => {
        for (const lat of [0, 10, -10, 45, -45, 75, -75]) {
            const plus = equalEarthWorldFromLngLat(FINITE_DIFF_H_DEGREES, lat);
            const minus = equalEarthWorldFromLngLat(-FINITE_DIFF_H_DEGREES, lat);
            const finiteDiffSlope = (plus.x - minus.x) / (2 * FINITE_DIFF_H_DEGREES);
            const analytic = equalEarthXScaleAtLat(lat);
            expect(Math.abs(analytic - finiteDiffSlope)).toBeLessThanOrEqual(FINITE_DIFF_TOLERANCE);
        }
    });

    test('is positive everywhere, including at the poles (EE poles are lines, not points)', () => {
        for (const lat of [0, 45, 89.9999, 90, -90]) {
            expect(equalEarthXScaleAtLat(lat)).toBeGreaterThan(0);
        }
    });
});

describe('latFromEqualEarthWorldY', () => {
    test('matches fixture latitudes at lng=0 (round trip through the forward function)', () => {
        for (const lat of [-90, -60, -45, -30, 0, 30, 45, 60, 90]) {
            const {y} = equalEarthWorldFromLngLat(0, lat);
            expect(latFromEqualEarthWorldY(y)).toBeCloseTo(lat, 6);
        }
    });

    test('agrees with lngLatFromEqualEarthWorld at a non-zero longitude (y is lng-independent)', () => {
        const world = equalEarthWorldFromLngLat(137, 52);
        const {lat} = lngLatFromEqualEarthWorld(world.x, world.y);
        expect(latFromEqualEarthWorldY(world.y)).toBeCloseTo(lat, 8);
    });
});
