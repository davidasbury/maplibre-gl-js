import {describe, expect, test} from 'vitest';
import {LngLat} from '../lng_lat.ts';
import {EqualEarthTransform} from './equal_earth_transform.ts';
import {coveringTiles} from './covering_tiles.ts';
import {OverscaledTileID} from '../../tile/tile_id.ts';

function createTransform(width = 1024, height = 768, renderWorldCopies = false): EqualEarthTransform {
    const transform = new EqualEarthTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies});
    transform.resize(width, height);
    return transform;
}

// NOTE (Stage B step 8): every test below calls setZoom() BEFORE setCenter(),
// not the more "natural" reverse order. setCenter() re-applies
// defaultConstrain() immediately, at whatever zoom is current at that
// instant -- and defaultConstrain's new zoom-dependent vertical clamp
// (Mechanism 3) hard-locks latitude to 0 whenever the world's content is
// shorter than the viewport, which is true at this transform's initial zoom
// (0) for these viewport sizes. Calling setCenter(highLat) first would
// silently clamp it to 0 right there, before setZoom ever runs -- setZoom
// first (matching handleJumpToCenterZoom's own order) avoids that entirely.

function keyOf(tile: OverscaledTileID): string {
    return `${tile.canonical.z}/${tile.canonical.x}/${tile.canonical.y}`;
}

describe('EqualEarthCoveringTilesDetailsProvider (analytic window v2, via coveringTiles)', () => {
    describe('full-world views cover every tile at the covering zoom', () => {
        test('z0 view (tileSize matched to transform) covers just the root tile', () => {
            const transform = createTransform();
            transform.setZoom(0);
            transform.setCenter(new LngLat(0, 0));
            const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 0});
            expect(tiles).toEqual([new OverscaledTileID(0, 0, 0, 0, 0)]);
        });

        test('z1 full-world view covers all 4 tiles', () => {
            const transform = createTransform();
            transform.setZoom(0);
            transform.setCenter(new LngLat(0, 0));
            // options.tileSize < transform.tileSize bumps the covering zoom
            // above the camera zoom (scaleZoom(512/256) = 1).
            const tiles = coveringTiles(transform, {tileSize: 256, minzoom: 0, maxzoom: 1});
            const keys = new Set(tiles.map(keyOf));
            expect(tiles).toHaveLength(4);
            for (const x of [0, 1]) {
                for (const y of [0, 1]) {
                    expect(keys.has(`1/${x}/${y}`)).toBe(true);
                }
            }
        });

        test('z2 full-world view covers all 16 tiles, bottom (south pole) row included -- the white-strip regression test', () => {
            const transform = createTransform();
            transform.setZoom(0);
            transform.setCenter(new LngLat(0, 0));
            // scaleZoom(512/128) = 2, so covering zoom = floor(0 + 2) = 2.
            const tiles = coveringTiles(transform, {tileSize: 128, minzoom: 0, maxzoom: 2});
            expect(tiles).toHaveLength(16);
            const keys = new Set(tiles.map(keyOf));
            for (let x = 0; x < 4; x++) {
                for (let y = 0; y < 4; y++) {
                    expect(keys.has(`2/${x}/${y}`)).toBe(true);
                }
            }
        });

        test('no duplicate tile IDs in a full-world result', () => {
            const transform = createTransform();
            transform.setZoom(0);
            transform.setCenter(new LngLat(0, 0));
            const tiles = coveringTiles(transform, {tileSize: 128, minzoom: 0, maxzoom: 2});
            const keys = tiles.map(keyOf);
            expect(new Set(keys).size).toBe(keys.length);
        });
    });

    describe('south/north pole sweep positions still resolve the pole row (blank-strip regression)', () => {
        test('(0, -70) z2: south pole row present', () => {
            const transform = createTransform();
            transform.setZoom(2);
            transform.setCenter(new LngLat(0, -70));
            const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 10});
            const keys = new Set(tiles.map(keyOf));
            // south pole row at z2 is y=3
            expect(keys.has('2/0/3')).toBe(true);
            expect(keys.has('2/1/3')).toBe(true);
            expect(keys.has('2/2/3')).toBe(true);
            expect(keys.has('2/3/3')).toBe(true);
        });

        test('(0, 75) z2: north pole row present', () => {
            const transform = createTransform();
            transform.setZoom(2);
            transform.setCenter(new LngLat(0, 75));
            const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 10});
            const keys = new Set(tiles.map(keyOf));
            // north pole row at z2 is y=0
            expect(keys.has('2/0/0')).toBe(true);
            expect(keys.has('2/1/0')).toBe(true);
            expect(keys.has('2/2/0')).toBe(true);
            expect(keys.has('2/3/0')).toBe(true);
        });
    });

    describe('mid-zoom regional view covers a neighborhood, not the whole world', () => {
        test('(-100, 40) z4 stays within a bounded neighborhood of x/y indices', () => {
            const transform = createTransform();
            transform.setZoom(4);
            transform.setCenter(new LngLat(-100, 40));
            const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 10});
            expect(tiles.length).toBeGreaterThan(0);
            // A z4 full world is 16x16 = 256 tiles; a genuinely regional view
            // should be a small fraction of that, not close to everything.
            expect(tiles.length).toBeLessThan(40);
            for (const tile of tiles) {
                expect(tile.canonical.z).toBeGreaterThanOrEqual(3);
                expect(tile.canonical.z).toBeLessThanOrEqual(5);
            }
        });

        test('(10, 50) z5 stays within a bounded neighborhood of x/y indices', () => {
            const transform = createTransform();
            transform.setZoom(5);
            transform.setCenter(new LngLat(10, 50));
            const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 10});
            expect(tiles.length).toBeGreaterThan(0);
            // A z5 full world is 32x32 = 1024 tiles.
            expect(tiles.length).toBeLessThan(60);
        });
    });

    describe('east-west (antimeridian) wrap', () => {
        // v2: the analytic window is centered on `center.lng` and does NOT
        // itself wrap -- when the window's continuous span crosses +-180,
        // the "other side" of the seam is only reachable via a genuine
        // world-copy wrap (getTileBoundingVolume's `+ 360*wrap` term), which
        // requires `renderWorldCopies: true` so the traversal seeds wraps
        // beyond 0 (see `allowWorldCopies`/`getWrap`). This replaces v1's
        // wrap-INDEPENDENT trick (`normalizeLngNear`, deleted) that faked
        // seam coverage at wrap 0 alone regardless of `renderWorldCopies`.
        test('(170, 0) z2 enumerates tiles on both sides of the seam (x near max at wrap 0, x near 0 at wrap 1)', () => {
            const transform = createTransform(1024, 768, true);
            transform.setZoom(2);
            transform.setCenter(new LngLat(170, 0));
            const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 10});
            expect(tiles.length).toBeGreaterThan(0);
            const commonZ = tiles[0].canonical.z;
            const numTiles = 1 << commonZ;
            const atCommonZ = tiles.filter(t => t.canonical.z === commonZ);
            // East side of the seam: on-screen directly, wrap 0.
            expect(atCommonZ.some(t => t.wrap === 0 && t.canonical.x === numTiles - 1)).toBe(true);
            // West side of the seam: only reachable as the next world copy
            // east of center, wrap 1 (center.lng=170 -> window extends past
            // +180 rather than below -180).
            expect(atCommonZ.some(t => t.wrap === 1 && t.canonical.x === 0)).toBe(true);
        });

        test('(-170, 0) z2 also enumerates tiles on both sides of the seam (x near 0 at wrap 0, x near max at wrap -1)', () => {
            const transform = createTransform(1024, 768, true);
            transform.setZoom(2);
            transform.setCenter(new LngLat(-170, 0));
            const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 10});
            expect(tiles.length).toBeGreaterThan(0);
            const commonZ = tiles[0].canonical.z;
            const numTiles = 1 << commonZ;
            const atCommonZ = tiles.filter(t => t.canonical.z === commonZ);
            expect(atCommonZ.some(t => t.wrap === 0 && t.canonical.x === 0)).toBe(true);
            expect(atCommonZ.some(t => t.wrap === -1 && t.canonical.x === numTiles - 1)).toBe(true);
        });

        test('deep zoom directly on the antimeridian produces a tight (bounded, not full-world) result', () => {
            const transform = createTransform();
            transform.setZoom(8);
            transform.setCenter(new LngLat(179.5, 0));
            const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 10});
            expect(tiles.length).toBeGreaterThan(0);
            // A full-world z8 result would be 256x256 = 65536 tiles; a tight
            // neighborhood straddling the seam should be a handful of tiles,
            // not any meaningful fraction of that (proves the analytic
            // window stays bounded here, not that some fallback is firing --
            // v2 has no fallback path at all).
            expect(tiles.length).toBeLessThan(100);
            const xs = new Set(tiles.map(t => t.canonical.x));
            const numTiles = 1 << tiles[0].canonical.z;
            expect(xs.has(0) || xs.has(numTiles - 1)).toBe(true);
        });

        test('no duplicate tile IDs when straddling the antimeridian', () => {
            const transform = createTransform(1024, 768, true);
            transform.setZoom(2);
            transform.setCenter(new LngLat(170, 0));
            const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 10});
            const keys = tiles.map(t => `${t.wrap}/${keyOf(t)}`);
            expect(new Set(keys).size).toBe(keys.length);
        });

        test('wrap exactness: center lng 180 requests exactly the seam-adjacent wraps (0 and 1), never |wrap| >= 2', () => {
            const transform = createTransform(1024, 768, true);
            transform.setZoom(4);
            transform.setCenter(new LngLat(180, 0));
            const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 10});
            const wraps = new Set(tiles.map(t => t.wrap));
            expect(wraps.has(0)).toBe(true);
            expect(wraps.has(1)).toBe(true);
            for (const wrap of wraps) {
                expect(Math.abs(wrap)).toBeLessThan(2);
            }
        });

        test('floor zoom on a wide viewport, center lng 146.28: far-east wrap tile (effective lng >= 360) present -- void-wedge regression', () => {
            // At the pole-fit floor on a wide viewport the visible span at
            // polar rows exceeds 360 degrees (seams curve inward), so the
            // east wedge needs tiles whose effective longitude
            // (-180 + 360*x/2^z + 360*wrap) reaches past 360. The old
            // +-180 window cap culled exactly those (owner repro
            // 2026-07-22: void wedges at the viewport edges at lng~146;
            // lng 0/90 escaped by edge-touching coincidence, which is why
            // G1 never caught it).
            const transform = createTransform(1440, 760, true);
            transform.setZoom(1.6087);
            transform.setCenter(new LngLat(146.28, 0));
            const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 22});
            const effectiveLngLo = (t: OverscaledTileID) => -180 + 360 * (t.canonical.x / (1 << t.canonical.z)) + 360 * t.wrap;
            expect(tiles.some((t) => effectiveLngLo(t) >= 360)).toBe(true);
        });

        test('mirror: center lng -146.28 requests a far-west wrap tile (effective lng < -360)', () => {
            const transform = createTransform(1440, 760, true);
            transform.setZoom(1.6087);
            transform.setCenter(new LngLat(-146.28, 0));
            const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 22});
            const effectiveLngHi = (t: OverscaledTileID) => -180 + 360 * ((t.canonical.x + 1) / (1 << t.canonical.z)) + 360 * t.wrap;
            expect(tiles.some((t) => effectiveLngHi(t) <= -360)).toBe(true);
        });

        test('wrap exactness: center lng 0 requests wrap 0 only', () => {
            const transform = createTransform(1024, 768, true);
            transform.setZoom(4);
            transform.setCenter(new LngLat(0, 0));
            const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 10});
            const wraps = new Set(tiles.map(t => t.wrap));
            expect(wraps).toEqual(new Set([0]));
        });
    });

    describe('boundedness (session 0013 regression: naive v1 froze the page at z12+)', () => {
        test('z12, center (30, 50), 1100x700 viewport: covering set stays small', () => {
            const transform = createTransform(1100, 700);
            transform.setZoom(12);
            transform.setCenter(new LngLat(30, 50));
            const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 22});
            expect(tiles.length).toBeGreaterThan(0);
            expect(tiles.length).toBeLessThan(60);
        });
    });
});
