import {describe, test, expect} from 'vitest';
import Point from '@mapbox/point-geometry';
import {LngLat} from '../lng_lat.ts';
import {EqualEarthTransform} from './equal_earth_transform.ts';
import {projectToEqualEarthWorldCoordinates, unprojectFromEqualEarthWorldCoordinates} from './equal_earth_utils.ts';
import {OverscaledTileID} from '../../tile/tile_id.ts';

function createTransform(zoom: number = 3, center: LngLat = new LngLat(0, 0)): EqualEarthTransform {
    const transform = new EqualEarthTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
    transform.resize(500, 500);
    // setZoom before setCenter (Stage B step 8): setCenter re-applies
    // defaultConstrain immediately at whatever zoom is current, and its new
    // zoom-dependent vertical clamp (Mechanism 3) hard-locks latitude to 0
    // whenever the world's content is shorter than the viewport -- true at
    // this transform's initial zoom (0) for a 500x500 viewport. Setting the
    // real zoom first (matching handleJumpToCenterZoom's own order) means
    // center's own constrain call sees the right zoom immediately.
    transform.setZoom(zoom);
    transform.setCenter(center);
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

    // Stage B step 8: dynamic lambda0 (central meridian tracks center.lng).
    // See docs/resources/2026-07-20-stage-b-step8-dynamic-lambda0-design.md
    // (outer project) for the full design and test plan this section
    // implements.
    describe('dynamic lambda0 (Stage B step 8)', () => {
        describe('center-pin invariant', () => {
            test('the map center always lands on the screen center, for several center.lng', () => {
                for (const lng of [0, 90, 180, -120]) {
                    const transform = createTransform(3, new LngLat(lng, 0));
                    const p = transform.locationToScreenPoint(new LngLat(lng, 0));
                    expect(p.x).toBeCloseTo(250, 6);
                    expect(p.y).toBeCloseTo(250, 6);
                }
            });
        });

        describe('fixed outline / rotating world', () => {
            test('locationToScreenPoint(center +-180) is identical across different center.lng at the same zoom', () => {
                // The outline (the screen position of the +-180-from-center
                // meridian) must not move when the world rotates under it --
                // this is the structural, by-construction consequence of
                // lambda0 === center.lng (see the design doc's "Core
                // decision"), not a special case.
                const lats = [0, 30, -30, 60, -60];
                let reference: Point[] | null = null;
                for (const centerLng of [0, 90, 180, -120]) {
                    const transform = createTransform(3, new LngLat(centerLng, 0));
                    const points = lats.flatMap(lat => [
                        transform.locationToScreenPoint(new LngLat(centerLng + 180, lat)),
                        transform.locationToScreenPoint(new LngLat(centerLng - 180, lat)),
                    ]);
                    if (reference === null) {
                        reference = points;
                    } else {
                        for (let i = 0; i < points.length; i++) {
                            expect(points[i].x).toBeCloseTo(reference[i].x, 6);
                            expect(points[i].y).toBeCloseTo(reference[i].y, 6);
                        }
                    }
                }
            });
        });

        describe('setLocationAtPoint end-to-end (closed-form solve)', () => {
            // Proof by construction, not by reasoning about the closed form:
            // after the call, locationToScreenPoint(lnglat) must return the
            // requested screen point, for several (lnglat, point) pairs
            // including ones that cross the antimeridian relative to the
            // transform's starting center.
            const cases: Array<{start: LngLat; lnglat: LngLat; point: Point}> = [
                {start: new LngLat(0, 0), lnglat: new LngLat(13, 10), point: new Point(15, 45)},
                {start: new LngLat(170, 0), lnglat: new LngLat(-170, 5), point: new Point(300, 200)},
                {start: new LngLat(-170, 0), lnglat: new LngLat(170, -20), point: new Point(100, 400)},
                {start: new LngLat(90, 30), lnglat: new LngLat(-179, -45), point: new Point(50, 50)},
            ];

            for (const {start, lnglat, point} of cases) {
                test(`start center ${start.lng},${start.lat} -> place ${lnglat.lng},${lnglat.lat} at (${point.x},${point.y})`, () => {
                    const transform = createTransform(4, start);
                    transform.setLocationAtPoint(lnglat, point);
                    const p = transform.locationToScreenPoint(lnglat);
                    expect(p.x).toBeCloseTo(point.x, 5);
                    expect(p.y).toBeCloseTo(point.y, 5);
                });
            }
        });

        describe('screen <-> location round trip with dynamic lambda0', () => {
            const locations = [
                new LngLat(0, 0),
                new LngLat(30, 45),
                new LngLat(-30, 45),
                new LngLat(150, -60),
            ];

            test('round trip holds for center.lng in {0, 90, 180}', () => {
                for (const centerLng of [0, 90, 180]) {
                    const transform = createTransform(3, new LngLat(centerLng, 0));
                    for (const location of locations) {
                        const roundTripped = transform.screenPointToLocation(transform.locationToScreenPoint(location));
                        expect(roundTripped.lng).toBeCloseTo(location.lng, 6);
                        expect(roundTripped.lat).toBeCloseTo(location.lat, 6);
                    }
                }
            });
        });

        describe('getProjectionData (Mechanism 2: render-side lambda0 + wrap seam)', () => {
            test('tileMercatorCoords x reflects wrap - center.lng/360, for wrap in {-1,0,1} and center.lng in {0,90}', () => {
                for (const centerLng of [0, 90]) {
                    const transform = createTransform(3, new LngLat(centerLng, 0));
                    for (const wrap of [-1, 0, 1]) {
                        const tileID = new OverscaledTileID(3, wrap, 3, 2, 2);
                        const data = transform.getProjectionData({overscaledTileID: tileID});
                        // Base (un-shifted) canonical x from
                        // TransformHelper.getMercatorTileCoordinates for
                        // tileID.canonical (x=2, z=3): 2 / 8 = 0.25.
                        const baseCanonicalX = 2 / 8;
                        const expectedX = baseCanonicalX + wrap - centerLng / 360;
                        expect(data.tileMercatorCoords[0]).toBeCloseTo(expectedX, 10);
                    }
                }
            });

            test('null overscaledTileID is untouched ([0,0,1,1], as before)', () => {
                const transform = createTransform(3, new LngLat(90, 0));
                const data = transform.getProjectionData({overscaledTileID: null});
                expect(data.tileMercatorCoords).toEqual([0, 0, 1, 1]);
            });
        });

        describe('defaultConstrain (Mechanism 3: zoom-dependent vertical clamp)', () => {
            // 500x500 viewport (matches createTransform's default resize).
            // At zoom 0 the world's content height (~249px) is shorter than
            // the viewport (500px): the "full extent fits" low-zoom regime
            // where the usable center-y interval is empty.
            test('at a zoom where world height < viewport height, lat locks to 0 and lng passes through', () => {
                const transform = createTransform(0, new LngLat(0, 0));
                transform.setCenter(new LngLat(37, 60));
                expect(transform.center.lat).toBe(0);
                expect(transform.center.lng).toBeCloseTo(37, 10);
            });

            // At zoom 2 the world (~997px tall) exceeds the viewport, and
            // lat=89 is far enough past the achievable range that the clamp
            // engages: the resulting center must sit exactly at the no-void
            // boundary, which locationToScreenPoint of the pole line proves
            // directly (screen y ~ 0, not floating in the middle of the
            // viewport and not negative/off-screen).
            test('at a higher zoom, center at lat 89 clamps to exactly the no-void bound', () => {
                const transform = createTransform(2, new LngLat(0, 0));
                transform.setCenter(new LngLat(0, 89));
                expect(transform.center.lat).toBeLessThan(89);
                const poleScreen = transform.locationToScreenPoint(new LngLat(transform.center.lng, 90));
                expect(poleScreen.y).toBeCloseTo(0, 6);
            });

            test('zoom clamp is unchanged: requests beyond [minZoom, maxZoom] are clamped', () => {
                const transform = new EqualEarthTransform({minZoom: 1, maxZoom: 10, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
                transform.resize(500, 500);
                transform.setZoom(50);
                expect(transform.zoom).toBe(10);
                transform.setZoom(-5);
                expect(transform.zoom).toBe(1);
            });
        });
    });
});
