import {describe, test, expect} from 'vitest';
import {EqualEarthAdaptiveProjection} from './equal_earth_adaptive_projection.ts';
import {EqualEarthAdaptiveTransform} from './equal_earth_adaptive_transform.ts';
import {createProjectionFromName} from './projection_factory.ts';
import {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import {type TransitionParameters} from '../../style/properties.ts';
import {LngLat} from '../lng_lat.ts';
import {OverscaledTileID} from '../../tile/tile_id.ts';

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
