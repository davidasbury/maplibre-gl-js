import {describe, test, expect} from 'vitest';
import Point from '@mapbox/point-geometry';
import {LngLat} from '../lng_lat.ts';
import {EqualEarthTransform} from './equal_earth_transform.ts';
import {projectToEqualEarthWorldCoordinates, unprojectFromEqualEarthWorldCoordinates} from './equal_earth_utils.ts';

function createTransform(zoom: number = 3, center: LngLat = new LngLat(0, 0)): EqualEarthTransform {
    const transform = new EqualEarthTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
    transform.resize(500, 500);
    transform.setCenter(center);
    transform.setZoom(zoom);
    return transform;
}

describe('EqualEarthTransform', () => {
    describe('screen orientation (y-down world convention regression)', () => {
        // Phases 1-2 were internally consistent in the paper's y-up convention
        // and would have rendered the world upside down; these tests pin the
        // y-down seam so that regression cannot come back silently.
        test('north of center lands higher on screen (smaller y)', () => {
            const transform = createTransform();
            const centerScreen = transform.locationToScreenPoint(new LngLat(0, 0));
            const northScreen = transform.locationToScreenPoint(new LngLat(0, 45));
            expect(northScreen.y).toBeLessThan(centerScreen.y);
        });

        test('east of center lands further right on screen (larger x)', () => {
            const transform = createTransform();
            const centerScreen = transform.locationToScreenPoint(new LngLat(0, 0));
            const eastScreen = transform.locationToScreenPoint(new LngLat(45, 0));
            expect(eastScreen.x).toBeGreaterThan(centerScreen.x);
        });

        test('map center lands on the screen center', () => {
            const transform = createTransform();
            const p = transform.locationToScreenPoint(new LngLat(0, 0));
            expect(p.x).toBeCloseTo(250, 6);
            expect(p.y).toBeCloseTo(250, 6);
        });
    });

    describe('screen <-> location round trip', () => {
        // Equator, mid-latitudes, high latitudes, both hemispheres. Exact
        // poles are deliberately absent: they are far off-screen at these
        // views and screen round-trips of off-screen points are not
        // meaningful.
        const locations = [
            new LngLat(0, 0),
            new LngLat(30, 45),
            new LngLat(-30, 45),
            new LngLat(30, -45),
            new LngLat(-120, 60),
            new LngLat(150, -60),
            new LngLat(60, 80),
        ];

        test('locationToScreenPoint then screenPointToLocation returns the original', () => {
            const transform = createTransform();
            for (const location of locations) {
                const roundTripped = transform.screenPointToLocation(transform.locationToScreenPoint(location));
                expect(roundTripped.lng).toBeCloseTo(location.lng, 8);
                expect(roundTripped.lat).toBeCloseTo(location.lat, 8);
            }
        });

        test('round trip also holds with a non-origin center', () => {
            const transform = createTransform(4, new LngLat(20, 30));
            for (const location of locations) {
                const roundTripped = transform.screenPointToLocation(transform.locationToScreenPoint(location));
                expect(roundTripped.lng).toBeCloseTo(location.lng, 8);
                expect(roundTripped.lat).toBeCloseTo(location.lat, 8);
            }
        });
    });

    describe('setLocationAtPoint', () => {
        test('places the location at the requested screen point', () => {
            const transform = createTransform(4);
            transform.setLocationAtPoint(new LngLat(13, 10), new Point(15, 45));
            const p = transform.locationToScreenPoint(new LngLat(13, 10));
            expect(p.x).toBeCloseTo(15, 6);
            expect(p.y).toBeCloseTo(45, 6);
            const location = transform.screenPointToLocation(new Point(15, 45));
            expect(location.lng).toBeCloseTo(13, 8);
            expect(location.lat).toBeCloseTo(10, 8);
        });
    });

    describe('world-square normalization anchors (Phase 4 regression)', () => {
        // Pin the fraction-of-world unit-square convention (the analogue of
        // MercatorCoordinate's unit world): before this normalization landed,
        // raw Equal Earth paper coordinates (x +-2.7066, y +-1.3174) leaked
        // into the engine, rendering the world ~5.4x oversized and anchored
        // at the world origin, and covering-tiles culled everything outside
        // [0, worldSize]^2. worldSize 1 makes the world coordinates the unit
        // square directly.

        // 0.5 - 1.3173627591574133 / 5.4132599673921497: the paper-space
        // north-pole y over EQUAL_EARTH_WORLD_EXTENT, y-flipped. World-y
        // deliberately spans only ~[0.2566, 0.7434] of the unit square (one
        // uniform divisor for both axes preserves equal-area shape).
        const northPoleWorldY = 0.25664151230629778;

        test('(0, 0) lands at the center of the unit square', () => {
            const p = projectToEqualEarthWorldCoordinates(1, new LngLat(0, 0));
            expect(Math.abs(p.x - 0.5)).toBeLessThanOrEqual(1e-12);
            expect(Math.abs(p.y - 0.5)).toBeLessThanOrEqual(1e-12);
        });

        test('(180, 0) lands at the right edge, equator height', () => {
            const p = projectToEqualEarthWorldCoordinates(1, new LngLat(180, 0));
            expect(Math.abs(p.x - 1.0)).toBeLessThanOrEqual(1e-12);
            expect(Math.abs(p.y - 0.5)).toBeLessThanOrEqual(1e-12);
        });

        test('(-180, 0) lands at the left edge', () => {
            const p = projectToEqualEarthWorldCoordinates(1, new LngLat(-180, 0));
            expect(Math.abs(p.x - 0.0)).toBeLessThanOrEqual(1e-12);
        });

        test('(0, 90) lands on the north-pole line at the pinned world y', () => {
            const p = projectToEqualEarthWorldCoordinates(1, new LngLat(0, 90));
            expect(Math.abs(p.x - 0.5)).toBeLessThanOrEqual(1e-12);
            expect(Math.abs(p.y - northPoleWorldY)).toBeLessThanOrEqual(1e-12);
        });

        test('y-down sanity: north pole above center, south pole below', () => {
            const north = projectToEqualEarthWorldCoordinates(1, new LngLat(0, 90));
            const south = projectToEqualEarthWorldCoordinates(1, new LngLat(0, -90));
            expect(north.y).toBeLessThan(0.5);
            expect(south.y).toBeGreaterThan(0.5);
        });

        test('unproject round-trips the anchors', () => {
            const anchors = [
                new LngLat(0, 0),
                new LngLat(180, 0),
                new LngLat(-180, 0),
                new LngLat(0, 90),
                new LngLat(0, -90),
                new LngLat(30, 45),
                new LngLat(-120, -60),
            ];
            for (const anchor of anchors) {
                const roundTripped = unprojectFromEqualEarthWorldCoordinates(1, projectToEqualEarthWorldCoordinates(1, anchor));
                expect(roundTripped.lng).toBeCloseTo(anchor.lng, 8);
                expect(roundTripped.lat).toBeCloseTo(anchor.lat, 8);
            }
        });
    });
});
