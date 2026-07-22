import {describe, test, expect} from 'vitest';
import Point from '@mapbox/point-geometry';
import {LngLat} from '../lng_lat.ts';
import {EqualEarthTransform} from './equal_earth_transform.ts';
import {projectToEqualEarthWorldCoordinates, unprojectFromEqualEarthWorldCoordinates} from './equal_earth_utils.ts';
import {OverscaledTileID} from '../../tile/tile_id.ts';
import {EQUAL_EARTH_WORLD_Y_NORTH_POLE, EQUAL_EARTH_WORLD_Y_SOUTH_POLE, EQUAL_EARTH_SQRT_AREA_RATIO} from '../equal_earth_coordinate.ts';
import {mercatorXfromLng, mercatorYfromLat} from '../mercator_coordinate.ts';
import {EXTENT} from '../../data/extent.ts';

// Shared with the source's own zFit derivation (defaultConstrain): the zoom
// at which world content height exactly equals the viewport height. Kept
// here as a helper (not re-implemented ad hoc per test) so every zFit
// assertion below is provably using the same formula as the source.
function computeZFit(transform: EqualEarthTransform, screenHeight: number): number {
    const contentHeightUnit = EQUAL_EARTH_WORLD_Y_SOUTH_POLE - EQUAL_EARTH_WORLD_Y_NORTH_POLE;
    return Math.log2(screenHeight / (contentHeightUnit * transform.tileSize));
}

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
            // Requesting zoom 0 now floors to zFit (the dynamic zoom floor,
            // see the "dynamic zoom floor" describe block below) rather than
            // landing at 0 -- at exactly zFit the usable center-y interval
            // has degenerated to a single point (world height == viewport
            // height exactly), which by construction is centered on the
            // equator, so lat still comes out ~0, just via a different path
            // than Stage B step 8's original "empty interval" branch.
            test('requesting a zoom below zFit floors to zFit, and lat still lands at the equator', () => {
                const transform = createTransform(0, new LngLat(0, 0));
                const zFit = computeZFit(transform, 500);
                expect(transform.zoom).toBeCloseTo(zFit, 6);
                transform.setCenter(new LngLat(37, 60));
                expect(transform.center.lat).toBeCloseTo(0, 6);
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

            test('maxZoom clamp is unchanged: requests beyond maxZoom are clamped', () => {
                const transform = new EqualEarthTransform({minZoom: 1, maxZoom: 10, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
                transform.resize(500, 500);
                transform.setZoom(50);
                expect(transform.zoom).toBe(10);
            });

            // minZoom-side clamp is now MAX(minZoom, zFit), not minZoom alone
            // -- for a 500x500 viewport zFit (~1.005) exceeds minZoom (1), so
            // the dynamic floor, not the configured minZoom, wins here.
            test('minZoom-side clamp is now max(minZoom, zFit), not minZoom alone', () => {
                const transform = new EqualEarthTransform({minZoom: 1, maxZoom: 10, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
                transform.resize(500, 500);
                const zFit = computeZFit(transform, 500);
                expect(zFit).toBeGreaterThan(1);
                transform.setZoom(-5);
                expect(transform.zoom).toBeCloseTo(zFit, 6);
            });
        });

        describe('dynamic zoom floor (owner follow-up)', () => {
            test('at 1100x700, applyConstrain(center, 0).zoom === zFit', () => {
                const transform = new EqualEarthTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
                transform.resize(1100, 700);
                const zFit = computeZFit(transform, 700);
                const result = transform.applyConstrain(new LngLat(0, 0), 0);
                expect(result.zoom).toBeCloseTo(zFit, 10);
            });

            test('zooming to zFit + 1 is untouched', () => {
                const transform = new EqualEarthTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
                transform.resize(1100, 700);
                const zFit = computeZFit(transform, 700);
                const result = transform.applyConstrain(new LngLat(0, 0), zFit + 1);
                expect(result.zoom).toBeCloseTo(zFit + 1, 10);
            });

            test('maxZoom clamp unchanged even with the floor active', () => {
                const transform = new EqualEarthTransform({minZoom: 0, maxZoom: 10, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
                transform.resize(1100, 700);
                const result = transform.applyConstrain(new LngLat(0, 0), 50);
                expect(result.zoom).toBe(10);
            });

            test('guards screenHeight === 0 (no floor applied, falls back to minZoom)', () => {
                const transform = new EqualEarthTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
                // Deliberately not resized (height stays 0): defaultConstrain
                // must not divide by zero or produce NaN/Infinity.
                const result = transform.applyConstrain(new LngLat(0, 0), 0);
                expect(Number.isFinite(result.zoom)).toBe(true);
                expect(result.zoom).toBe(0);
            });
        });

        describe('outline-fit zoom floor (antimeridian-clip view mode)', () => {
            // Source-mirrored formula (same OUTLINE_FIT_MARGIN = 0.94): the
            // zoom at which the outline's limiting dimension occupies 94% of
            // the viewport. Unit x-span is 1 (step-5 normalization), so
            // width-fit is just screenWidth px against one world.
            function computeZOutlineFit(transform: EqualEarthTransform, screenWidth: number, screenHeight: number): number {
                const contentHeightUnit = EQUAL_EARTH_WORLD_Y_SOUTH_POLE - EQUAL_EARTH_WORLD_Y_NORTH_POLE;
                const fitPx = 0.94 * Math.min(screenWidth, screenHeight / contentHeightUnit);
                return Math.log2(fitPx / transform.tileSize);
            }

            test('flag off (default): floor is bit-identical to pole-fit zFit', () => {
                const transform = new EqualEarthTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
                transform.resize(1100, 700);
                expect(transform.outlineFitZoomFloor).toBe(false);
                const result = transform.applyConstrain(new LngLat(0, 0), 0);
                expect(result.zoom).toBeCloseTo(computeZFit(transform, 700), 10);
            });

            test('flag on at 1100x700: requesting zoom 0 lands at the outline-fit floor (below pole-fit)', () => {
                const transform = new EqualEarthTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
                transform.resize(1100, 700);
                transform.outlineFitZoomFloor = true;
                const zOutline = computeZOutlineFit(transform, 1100, 700);
                expect(zOutline).toBeLessThan(computeZFit(transform, 700));
                const result = transform.applyConstrain(new LngLat(0, 0), 0);
                expect(result.zoom).toBeCloseTo(zOutline, 10);
            });

            test('flag on below pole-fit: lat hard-locks to the equator (world shorter than viewport)', () => {
                const transform = new EqualEarthTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
                transform.resize(1100, 700);
                transform.outlineFitZoomFloor = true;
                const result = transform.applyConstrain(new LngLat(30, 45), 0);
                expect(result.center.lat).toBe(0);
                expect(result.center.lng).toBe(30);
            });

            test('flag on, zoom above pole-fit: constrain unchanged (poles still pin to viewport edges)', () => {
                const transform = new EqualEarthTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
                transform.resize(1100, 700);
                const zFit = computeZFit(transform, 700);
                const reference = transform.applyConstrain(new LngLat(10, 80), zFit + 2);
                transform.outlineFitZoomFloor = true;
                const withFlag = transform.applyConstrain(new LngLat(10, 80), zFit + 2);
                expect(withFlag.zoom).toBeCloseTo(reference.zoom, 12);
                expect(withFlag.center.lat).toBeCloseTo(reference.center.lat, 12);
            });

            test('flipping the flag off re-clamps an out-of-floor zoom back up to pole-fit', () => {
                const transform = new EqualEarthTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
                transform.resize(1100, 700);
                transform.outlineFitZoomFloor = true;
                const below = transform.applyConstrain(new LngLat(0, 0), 0);
                transform.outlineFitZoomFloor = false;
                const reClamped = transform.applyConstrain(below.center, below.zoom);
                expect(reClamped.zoom).toBeCloseTo(computeZFit(transform, 700), 10);
            });

            test('flag on with zero-size viewport (never resized): no NaN/Infinity, minZoom fallback', () => {
                const transform = new EqualEarthTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
                // Deliberately not resized (width and height stay 0): the
                // width>0 guard must keep the outline-fit branch from
                // producing NaN/-Infinity, degrading to the same minZoom
                // fallback the height-0 guard already provides.
                transform.outlineFitZoomFloor = true;
                const result = transform.applyConstrain(new LngLat(0, 0), 0);
                expect(Number.isFinite(result.zoom)).toBe(true);
                expect(result.zoom).toBe(0);
            });
        });
    });

    describe('projectTileCoordinates (Stage B step 9: symbol placement projection)', () => {
        // The contract these tests pin: projectTileCoordinates (the method
        // symbol placement, collision and symbol queryRenderedFeatures
        // project anchors through) must agree with locationToScreenPoint —
        // i.e. with where the Equal Earth shader actually draws — for the
        // same geographic point. The step-9 root cause was this method
        // multiplying raw tile coordinates by the mercator-planar per-tile
        // matrix instead.

        // Tile addressing of a lng/lat at a given zoom + the in-tile
        // fractional coordinates, mirroring how symbol anchors are stored
        // (tile units 0..EXTENT within a canonical tile).
        function tileCoordsFor(lng: number, lat: number, z: number, wrap: number = 0) {
            const scale = 1 << z;
            const mercX = mercatorXfromLng(lng);
            const mercY = mercatorYfromLat(lat);
            const tileX = Math.min(Math.floor(mercX * scale), scale - 1);
            const tileY = Math.min(Math.floor(mercY * scale), scale - 1);
            const inTileX = (mercX * scale - tileX) * EXTENT;
            const inTileY = (mercY * scale - tileY) * EXTENT;
            return {
                unwrapped: new OverscaledTileID(z, wrap, z, tileX, tileY).toUnwrapped(),
                x: inTileX,
                y: inTileY
            };
        }

        function clipToScreen(transform: EqualEarthTransform, clip: Point): Point {
            return new Point(
                (clip.x + 1) / 2 * transform.width,
                (-clip.y + 1) / 2 * transform.height
            );
        }

        test('agrees with locationToScreenPoint across latitudes and zooms (center.lng = 0)', () => {
            const transform = createTransform(3);
            for (const [lng, lat] of [[0, 0], [45, 30], [-120, -55], [170, 70], [-30, 82]]) {
                for (const z of [0, 2, 5]) {
                    const {unwrapped, x, y} = tileCoordsFor(lng, lat, z);
                    const projection = transform.projectTileCoordinates(x, y, unwrapped, null);
                    const viaScreen = transform.locationToScreenPoint(new LngLat(lng, lat));
                    const viaTile = clipToScreen(transform, projection.point);
                    expect(viaTile.x).toBeCloseTo(viaScreen.x, 4);
                    expect(viaTile.y).toBeCloseTo(viaScreen.y, 4);
                    expect(projection.signedDistanceFromCamera).toBeGreaterThan(0);
                    expect(projection.isOccluded).toBe(false);
                }
            }
        });

        test('keys off the live central meridian (center.lng != 0)', () => {
            const transform = createTransform(2, new LngLat(90, 0));
            const {unwrapped, x, y} = tileCoordsFor(90, 20, 3);
            const viaTile = clipToScreen(transform, transform.projectTileCoordinates(x, y, unwrapped, null).point);
            const viaScreen = transform.locationToScreenPoint(new LngLat(90, 20));
            expect(viaTile.x).toBeCloseTo(viaScreen.x, 4);
            expect(viaTile.y).toBeCloseTo(viaScreen.y, 4);
            // And the on-meridian point sits at the horizontal screen center
            // (the lambda0-tracking invariant), pinning that the projection
            // really used the CURRENT center longitude.
            expect(viaTile.x).toBeCloseTo(transform.width / 2, 4);
        });

        test('world copies project with unwrapped longitude (wrap folded in, seam-continuous)', () => {
            const transform = createTransform(2, new LngLat(170, 0));
            // A point at lng -175 on wrap +1 is the copy at unwrapped +185:
            // 15 degrees east of the central meridian, NOT 345 west.
            const {unwrapped, x, y} = tileCoordsFor(-175, 10, 2, 1);
            const viaTile = clipToScreen(transform, transform.projectTileCoordinates(x, y, unwrapped, null).point);
            const viaScreen = transform.locationToScreenPoint(new LngLat(185, 10));
            expect(viaTile.x).toBeCloseTo(viaScreen.x, 4);
            expect(viaTile.y).toBeCloseTo(viaScreen.y, 4);
            expect(viaTile.x).toBeGreaterThan(transform.width / 2);
        });
    });

    describe('linearized high-zoom render path (f32 round 2)', () => {
        // The per-tile linearized projection data must be the sub-0.05px
        // twin of the exact f64 projection (projectTileCoordinates) across
        // the whole tile — that budget is what makes the shader's f32
        // matrix path safe to substitute for the polynomial at high zoom.

        function tileContaining(lng: number, lat: number, canonicalZ: number, overscaledZ: number): OverscaledTileID {
            const scale = 1 << canonicalZ;
            const tileX = Math.min(Math.floor(mercatorXfromLng(lng) * scale), scale - 1);
            const tileY = Math.min(Math.floor(mercatorYfromLat(lat) * scale), scale - 1);
            return new OverscaledTileID(overscaledZ, 0, canonicalZ, tileX, tileY);
        }

        // Shader twin: clip = M·(p, 0, 1) + quadUV·(px·py) + quadVV·(py²).
        function evalLinearized(data: {mainMatrix: ArrayLike<number>; equalEarthQuadUV?: number[]; equalEarthQuadVV?: number[]}, px: number, py: number): {x: number; y: number; w: number} {
            const m = data.mainMatrix;
            const out = [0, 0, 0, 0];
            for (let row = 0; row < 4; row++) {
                out[row] = m[row] * px + m[4 + row] * py + m[12 + row] +
                    data.equalEarthQuadUV[row] * px * py +
                    data.equalEarthQuadVV[row] * py * py;
            }
            return {x: out[0] / out[3], y: out[1] / out[3], w: out[3]};
        }

        test.each([
            {canonicalZ: 14, zoom: 14, lng: 30, lat: 50},
            {canonicalZ: 14, zoom: 18, lng: 30, lat: 50},
            {canonicalZ: 13, zoom: 16, lng: -122.26, lat: 37.79},
            {canonicalZ: 15, zoom: 20, lng: 170.1, lat: -45.3},
            {canonicalZ: 18, zoom: 22, lng: 30, lat: 50},
        ])('agrees with the exact projection within 0.05 px (canonical z$canonicalZ at display z$zoom)', ({canonicalZ, zoom, lng, lat}) => {
            const transform = createTransform(zoom, new LngLat(lng, lat));
            const tileID = tileContaining(lng, lat, canonicalZ, Math.max(canonicalZ, Math.floor(zoom)));
            const data = transform.getProjectionData({overscaledTileID: tileID});
            // Linearized mode must actually be active for these combos.
            expect(data.tileMercatorCoords[2]).toBe(0);
            const unwrapped = tileID.toUnwrapped();
            let maxErrorPx = 0;
            for (let px = 0; px <= EXTENT; px += EXTENT / 8) {
                for (let py = 0; py <= EXTENT; py += EXTENT / 8) {
                    const exact = transform.projectTileCoordinates(px, py, unwrapped, null);
                    const approx = evalLinearized(data, px, py);
                    const dx = (approx.x - exact.point.x) / 2 * transform.width;
                    const dy = (approx.y - exact.point.y) / 2 * transform.height;
                    maxErrorPx = Math.max(maxErrorPx, Math.hypot(dx, dy));
                }
            }
            expect(maxErrorPx).toBeLessThan(0.05);
        });

        test('low zoom stays on the polynomial path', () => {
            const transform = createTransform(8, new LngLat(30, 50));
            const tileID = tileContaining(30, 50, 8, 8);
            const data = transform.getProjectionData({overscaledTileID: tileID});
            expect(data.tileMercatorCoords[2]).toBeGreaterThan(0);
        });

        test('pole-row tiles stay on the polynomial path (sentinel vertices)', () => {
            const transform = createTransform(16, new LngLat(30, 85));
            const canonicalZ = 14;
            const tileID = new OverscaledTileID(16, 0, canonicalZ, Math.floor(mercatorXfromLng(30) * (1 << canonicalZ)), 0);
            const data = transform.getProjectionData({overscaledTileID: tileID});
            expect(data.tileMercatorCoords[2]).toBeGreaterThan(0);
        });

        test('extreme overzoom over the residual budget falls back to the polynomial path', () => {
            const transform = createTransform(18, new LngLat(30, 50));
            // canonical z8 tile displayed at z18: span³·worldSize far over budget
            const tileID = tileContaining(30, 50, 8, 18);
            const data = transform.getProjectionData({overscaledTileID: tileID});
            expect(data.tileMercatorCoords[2]).toBeGreaterThan(0);
        });

        test('polynomial-mode data carries explicit zero quad corrections', () => {
            const transform = createTransform(3, new LngLat(0, 0));
            const tileID = tileContaining(0, 0, 3, 3);
            const data = transform.getProjectionData({overscaledTileID: tileID});
            expect(data.equalEarthQuadUV).toEqual([0, 0, 0, 0]);
            expect(data.equalEarthQuadVV).toEqual([0, 0, 0, 0]);
        });
    });

    describe('thickness/radius latitude correction (Stage B cleanup item 3)', () => {
        test('the TS-derived sqrt(G) matches the shader literal (drift guard)', () => {
            // The shader chunk pins EE_SQRT_AREA_RATIO = 1.1607026718 as a
            // float literal (GLSL cannot import); this guards the two
            // derivations against drifting apart.
            expect(EQUAL_EARTH_SQRT_AREA_RATIO).toBeCloseTo(1.1607026718, 9);
        });

        test('getCircleRadiusCorrection cancels the shader correction at the viewport center', () => {
            const equatorTransform = createTransform(4, new LngLat(0, 0));
            // shader at lat 0: 1/(sqrt(G)·cos 0); CPU: sqrt(G)·cos 0 — product 1
            expect(equatorTransform.getCircleRadiusCorrection()).toBeCloseTo(EQUAL_EARTH_SQRT_AREA_RATIO, 12);
            const midLatTransform = createTransform(4, new LngLat(0, 60));
            expect(midLatTransform.getCircleRadiusCorrection())
                .toBeCloseTo(EQUAL_EARTH_SQRT_AREA_RATIO * Math.cos(Math.PI / 3), 12);
        });

        test('linearized tiles ship a capped per-tile thickness correction in tileMercatorCoords.x', () => {
            const transform = createTransform(16, new LngLat(30, 50));
            const scale = 1 << 14;
            const tileID = new OverscaledTileID(16, 0, 14,
                Math.floor(mercatorXfromLng(30) * scale), Math.floor(mercatorYfromLat(50) * scale));
            const data = transform.getProjectionData({overscaledTileID: tileID});
            expect(data.tileMercatorCoords[2]).toBe(0); // linearized sentinel
            const expected = 1 / (EQUAL_EARTH_SQRT_AREA_RATIO * Math.cos(50 * Math.PI / 180));
            expect(data.tileMercatorCoords[0]).toBeCloseTo(expected, 2);
            expect(data.tileMercatorCoords[0]).toBeLessThanOrEqual(8.0);
        });
    });
});
