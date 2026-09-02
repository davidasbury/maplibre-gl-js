import {describe, test, expect} from 'vitest';
import {EqualEarthAdaptiveProjection} from './equal_earth_adaptive_projection.ts';
import {EqualEarthAdaptiveTransform} from './equal_earth_adaptive_transform.ts';
import {createProjectionFromName} from './projection_factory.ts';
import {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import {type TransitionParameters} from '../../style/properties.ts';
import {LngLat} from '../lng_lat.ts';
import {OverscaledTileID} from '../../tile/tile_id.ts';
import {MercatorTransform} from './mercator_transform.ts';
import {coveringTiles} from './covering_tiles.ts';

const BLEND_EXPRESSION = ['interpolate', ['linear'], ['zoom'], 4, 'equal-earth', 6, 'mercator'];

function projectionAtZoom(zoom: number): EqualEarthAdaptiveProjection {
    const projection = new EqualEarthAdaptiveProjection({type: BLEND_EXPRESSION} as any);
    projection.updateTransitions({transition: false} as any as TransitionParameters);
    projection.recalculate(new EvaluationParameters(zoom));
    return projection;
}

describe('EqualEarthAdaptiveProjection', () => {
    test('transitionState: pure Equal Earth below the lower stop', () => {
        expect(projectionAtZoom(0).transitionState).toBe(1);
        expect(projectionAtZoom(3.9).transitionState).toBe(1);
        expect(projectionAtZoom(4).transitionState).toBe(1);
    });

    test('transitionState: pure mercator above the upper stop', () => {
        expect(projectionAtZoom(6).transitionState).toBe(0);
        expect(projectionAtZoom(12).transitionState).toBe(0);
    });

    test('transitionState: strictly between 0 and 1 mid-blend, monotonic in zoom', () => {
        const t45 = projectionAtZoom(4.5).transitionState;
        const t50 = projectionAtZoom(5.0).transitionState;
        const t55 = projectionAtZoom(5.5).transitionState;
        expect(t45).toBeGreaterThan(0);
        expect(t45).toBeLessThan(1);
        expect(t50).toBeCloseTo(0.5, 5);
        expect(t45).toBeGreaterThan(t50);
        expect(t50).toBeGreaterThan(t55);
    });

    test('shader variant follows the dominant endpoint', () => {
        expect(projectionAtZoom(3).shaderVariantName).toBe('equal-earth');
        expect(projectionAtZoom(5).shaderVariantName).toBe('equal-earth');
        expect(projectionAtZoom(7).shaderVariantName).not.toBe('equal-earth');
    });

    test('no globe controls, no latitude error correction', () => {
        const projection = projectionAtZoom(5);
        expect(projection.useGlobeControls).toBe(false);
        expect(projection.latitudeErrorCorrectionRadians).toBe(0);
    });
});

describe('EqualEarthAdaptiveTransform', () => {
    function createTransform(eeness: number): EqualEarthAdaptiveTransform {
        const transform = new EqualEarthAdaptiveTransform();
        transform.resize(800, 600);
        transform.setZoom(5);
        transform.setCenter(new LngLat(10, 45));
        transform.setTransitionState(eeness, 0);
        return transform;
    }

    const tileID = new OverscaledTileID(5, 0, 5, 16, 11);

    test('projection data at transition 1 is the Equal Earth data with transition 1', () => {
        const transform = createTransform(1);
        const data = transform.getProjectionData({overscaledTileID: tileID, applyGlobeMatrix: true, applyTerrainMatrix: false});
        expect(data.projectionTransition).toBe(1);
        // EE polynomial mode: tileMercatorCoords carries a real mercator span
        // (zw > 0) shifted into the lambda0-relative frame.
        expect(data.tileMercatorCoords[2]).toBeGreaterThan(0);
        expect(data.equalEarthQuadUV).toBeDefined();
    });

    test('projection data at transition 0 is exactly the mercator data', () => {
        const transform = createTransform(0);
        const data = transform.getProjectionData({overscaledTileID: tileID, applyGlobeMatrix: true, applyTerrainMatrix: false});
        expect(data.projectionTransition).toBe(0);
        expect(data.equalEarthQuadUV).toBeUndefined();
    });

    test('mid-blend: EE main data, mercator fallback matrix, fractional transition', () => {
        const transform = createTransform(0.5);
        const data = transform.getProjectionData({overscaledTileID: tileID, applyGlobeMatrix: true, applyTerrainMatrix: false});
        expect(data.projectionTransition).toBe(0.5);
        expect(data.tileMercatorCoords[2]).toBeGreaterThan(0);
        expect(data.fallbackMatrix).toBeDefined();
        // The fallback must be the mercator per-tile matrix, which differs
        // from the EE whole-world mainMatrix.
        expect(Array.from(data.fallbackMatrix)).not.toEqual(Array.from(data.mainMatrix));
    });

    test('render-to-texture draws (applyGlobeMatrix false) force transition 0', () => {
        const transform = createTransform(0.5);
        const data = transform.getProjectionData({overscaledTileID: tileID, applyGlobeMatrix: false, applyTerrainMatrix: false});
        expect(data.projectionTransition).toBe(0);
    });

    test('center anchoring: the viewport center inverts to the map center in every regime', () => {
        for (const eeness of [1, 0.5, 0]) {
            const transform = createTransform(eeness);
            const centerLoc = transform.screenPointToLocation(transform.centerPoint);
            expect(centerLoc.lng).toBeCloseTo(10, 4);
            expect(centerLoc.lat).toBeCloseTo(45, 4);
        }
    });

    test('clone preserves the transition value', () => {
        const transform = createTransform(0.37);
        const clone = transform.clone() as EqualEarthAdaptiveTransform;
        const data = clone.getProjectionData({overscaledTileID: tileID, applyGlobeMatrix: true, applyTerrainMatrix: false});
        expect(data.projectionTransition).toBeCloseTo(0.37, 6);
    });
});

describe('projection factory routing', () => {
    test('an expression containing equal-earth routes to the adaptive composite', () => {
        const {projection, transform} = createProjectionFromName(BLEND_EXPRESSION as any);
        expect(projection).toBeInstanceOf(EqualEarthAdaptiveProjection);
        expect(transform).toBeInstanceOf(EqualEarthAdaptiveTransform);
    });

    test('the equal-earth-adaptive preset routes to the adaptive composite with the default stops', () => {
        const {projection} = createProjectionFromName('equal-earth-adaptive' as any);
        expect(projection).toBeInstanceOf(EqualEarthAdaptiveProjection);
        const p = projection as EqualEarthAdaptiveProjection;
        p.updateTransitions({transition: false} as any as TransitionParameters);
        p.recalculate(new EvaluationParameters(3));
        expect(p.transitionState).toBe(1);
        p.recalculate(new EvaluationParameters(7));
        expect(p.transitionState).toBe(0);
    });

    test('vertical-perspective expressions still route to globe', () => {
        const {projection} = createProjectionFromName(['interpolate', ['linear'], ['zoom'], 11, 'vertical-perspective', 12, 'mercator'] as any);
        expect(projection).not.toBeInstanceOf(EqualEarthAdaptiveProjection);
    });
});

describe('blend-aware constrain (owner pole-clamp design, 2026-07-23)', () => {
    function createTransform(eeness: number, zoom: number, lat: number): EqualEarthAdaptiveTransform {
        const transform = new EqualEarthAdaptiveTransform();
        transform.setTransitionState(eeness, 0);
        transform.resize(1100, 700);
        transform.setZoom(zoom);
        transform.setCenter(new LngLat(16, lat));
        return transform;
    }

    test('t=1: zoom floor matches static Equal Earth pole-fit (no below-floor voids)', () => {
        const transform = createTransform(1, 1.4, 0);
        // EE pole-fit floor for a 700px viewport is ~1.49 — 1.4 must clamp up.
        expect(transform.zoom).toBeGreaterThan(1.45);
    });

    test('t=0: zoom floor relaxes to the full mercator world height', () => {
        const transform = createTransform(0, 1.4, 0);
        // mercator content height is the full unit world: floor ≈ log2(700/512) ≈ 0.45.
        expect(transform.zoom).toBeCloseTo(1.4, 5);
    });

    test('mid-blend: high latitudes stay reachable (the Svalbard case)', () => {
        // Pre-fix, t=0.75 at z4.5 clamped a lat-75 request to ~65.2 —
        // Svalbard (74–81N) was unreachable mid-blend.
        const transform = createTransform(0.75, 4.5, 75);
        expect(transform.center.lat).toBeGreaterThan(74);
    });

    test('clamp endpoints: t=1 docks the EE pole, t=0 docks the mercator cut-off', () => {
        const ee = createTransform(1, 4.5, 90);
        const merc = createTransform(0, 4.5, 90);
        // Both clamp below 90; the mercator-side clamp must respect the
        // ±85.05 world edge (nothing beyond it exists to dock).
        expect(ee.center.lat).toBeLessThan(90);
        expect(merc.center.lat).toBeLessThanOrEqual(85.06);
        // The reachable ceiling should not DECREASE as eeness falls at
        // fixed zoom (the pre-fix behavior): mid-blend must lie between.
        const mid = createTransform(0.5, 4.5, 90);
        expect(mid.center.lat).toBeGreaterThanOrEqual(Math.min(ee.center.lat, merc.center.lat) - 0.01);
    });

    test('clamp ceiling rises monotonically and continuously as eeness falls', () => {
        // Measured curve at z4.5 (1100x700): 65.16 (t=1, pure-EE pole dock)
        // rising smoothly to 84.02 (t=0, mercator cut-off dock). Steepest
        // near t=1 (~5 deg per 0.05 step — smooth, not a pop); monotonic
        // throughout. Guard both properties.
        let prev = null;
        for (let t = 1; t >= -1e-9; t -= 0.05) {
            const lat = createTransform(+t.toFixed(2), 4.5, 90).center.lat;
            if (prev !== null) {
                expect(lat).toBeGreaterThanOrEqual(prev - 1e-9); // monotonic
                expect(lat - prev).toBeLessThan(6); // continuous (no jump)
            }
            prev = lat;
        }
    });
});

describe('mid-blend pitched camera (owner repro 2026-09-02: half-blank screen on zoom-out)', () => {
    // The bug: entering the blend with a tilted view, tile selection and the
    // shared far plane both came from the EE child, whose camera is clamped
    // flat — the pitched, rotated, mostly-mercator render showed world the
    // flat window never selected (a world-fixed blank region that rotated
    // with bearing) and far-clipped the rest near the horizon.
    function createPitchedTransform(eeness: number, pitch: number, bearing: number): EqualEarthAdaptiveTransform {
        const transform = new EqualEarthAdaptiveTransform();
        transform.resize(800, 600);
        transform.setZoom(5);
        transform.setCenter(new LngLat(10, 45));
        transform.setPitch(pitch);
        transform.setBearing(bearing);
        transform.setTransitionState(eeness, 0);
        return transform;
    }

    // Same camera state on a plain upstream MercatorTransform — a code path
    // sharing no logic with the EE window (real frustum intersection), so
    // agreement here is an independent check, not self-confirmation.
    function mercatorTwin(transform: EqualEarthAdaptiveTransform): MercatorTransform {
        const merc = new MercatorTransform();
        merc.resize(800, 600);
        merc.setZoom(transform.zoom);
        merc.setCenter(transform.center);
        merc.setPitch(transform.pitch);
        merc.setBearing(transform.bearing);
        return merc;
    }

    test('covering tiles cover the whole pitched+rotated mercator view at blend entry', () => {
        const transform = createPitchedTransform(0.05, 60, 45);
        expect(transform.pitch).toBeCloseTo(57, 5); // decayed, but very much nonzero
        const merc = mercatorTwin(transform);
        // Not an exact-key superset: the EE provider's latitude-adaptive
        // tile zoom (2026-07-23) legitimately selects coarser tiles at
        // higher latitudes, so a mercator tile counts as covered when the
        // adaptive set holds it or any ancestor at the same wrap.
        const adaptiveKeys = new Set(coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 10})
            .map((t) => `${t.canonical.z}/${t.canonical.x}/${t.canonical.y}/${t.wrap}`));
        const mercTiles = coveringTiles(merc, {tileSize: 512, minzoom: 0, maxzoom: 10});
        expect(mercTiles.length).toBeGreaterThan(0);
        const covered = (tile: OverscaledTileID) => {
            for (let z = tile.canonical.z; z >= 0; z--) {
                const dz = tile.canonical.z - z;
                if (adaptiveKeys.has(`${z}/${tile.canonical.x >> dz}/${tile.canonical.y >> dz}/${tile.wrap}`)) return true;
            }
            return false;
        };
        const missing = mercTiles.filter((t) => !covered(t)).map((t) => `${t.canonical.z}/${t.canonical.x}/${t.canonical.y}/${t.wrap}`);
        expect(missing).toEqual([]);
    });

    test('flat camera keeps the original regional window (no over-fetch at pitch 0)', () => {
        const flat = createPitchedTransform(0.05, 0, 0);
        const flatCount = coveringTiles(flat, {tileSize: 512, minzoom: 0, maxzoom: 10}).length;
        const worldTilesAtZ4 = 16 * 16;
        expect(flatCount).toBeLessThan(worldTilesAtZ4 / 4);
    });

    test('mid-blend far plane reaches the pitched mercator horizon', () => {
        const transform = createPitchedTransform(0.05, 60, 0);
        const merc = mercatorTwin(transform);
        expect(transform.farZ).toBeGreaterThanOrEqual(merc.farZ * 0.999);
        // And the pitched far plane is genuinely farther than the flat one —
        // i.e. the encompassing branch actually engaged.
        const flat = createPitchedTransform(0.05, 0, 0);
        expect(transform.farZ).toBeGreaterThan(flat.farZ);
    });
});

describe('mid-blend pitched tile budget (owner report 2026-09-02: greedy fetch froze the browser)', () => {
    // The camera-angle window expansion alone selected every tile at the
    // full covering zoom out to the pitched horizon — 920 z5 tiles at blend
    // entry on a 1400x800 view. With a pitched camera the provider now
    // enables the shared distance-based LOD, collapsing far rows to coarser
    // zooms exactly as pitched mercator does (147 tiles, z2..z7 pyramid).
    function createTransform(zoom: number, eeness: number, pitch: number, bearing: number): EqualEarthAdaptiveTransform {
        const transform = new EqualEarthAdaptiveTransform();
        transform.resize(1400, 800);
        transform.setZoom(zoom);
        transform.setCenter(new LngLat(10, 45));
        transform.setPitch(pitch);
        transform.setBearing(bearing);
        transform.setTransitionState(eeness, 0);
        return transform;
    }

    test('blend entry, full pitch: bounded, with a coarser-toward-horizon pyramid', () => {
        const transform = createTransform(5.95, 0.025, 60, 45);
        const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 10});
        expect(tiles.length).toBeGreaterThan(0);
        expect(tiles.length).toBeLessThan(300);
        const zooms = new Set(tiles.map((t) => t.canonical.z));
        expect(zooms.size).toBeGreaterThan(1); // LOD actually engaged
    });

    test('flat camera keeps constant-zoom selection (LOD stays off)', () => {
        const transform = createTransform(5.95, 0.025, 0, 0);
        const tiles = coveringTiles(transform, {tileSize: 512, minzoom: 0, maxzoom: 10});
        const zooms = new Set(tiles.map((t) => t.canonical.z));
        expect(zooms.size).toBe(1);
        expect(tiles.length).toBeLessThan(30);
    });
});
