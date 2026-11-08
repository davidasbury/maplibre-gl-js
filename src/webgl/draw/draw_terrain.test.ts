import {describe, test, expect} from 'vitest';
import {usesGlobeMesh} from './draw_terrain.ts';
import {GlobeProjection} from '../../geo/projection/globe_projection.ts';
import {EqualEarthAdaptiveProjection} from '../../geo/projection/equal_earth_adaptive_projection.ts';
import {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import {createFrameRenderData} from '../../util/test/util.ts';

import type {FrameRenderContext} from '../../render/frame_render_context.ts';
import type {Projection} from '../../geo/projection/projection.ts';
import type {TransitionParameters} from '../../style/properties.ts';

// The frame data map.ts builds from the style's projection.
function contextFor(projection: Projection): FrameRenderContext {
    const projectionTransition = projection.transitionState;
    const data = {
        ...createFrameRenderData(),
        projectionTransition,
        isRenderingGlobe: projectionTransition > 0,
        projectionShaderVariant: {name: projection.shaderVariantName, define: projection.shaderDefine, prelude: projection.shaderPreludeCode}
    };
    return {data} as FrameRenderContext;
}

function evaluated<T extends Projection & {updateTransitions(p: TransitionParameters): void; recalculate(p: EvaluationParameters): void}>(projection: T, zoom: number): T {
    projection.updateTransitions({transition: false} as any as TransitionParameters);
    projection.recalculate(new EvaluationParameters(zoom));
    return projection;
}

describe('usesGlobeMesh', () => {
    test('globe adds the pole geometry', () => {
        const globe = evaluated(new GlobeProjection({type: 'globe'}, {}), 2);
        expect(globe.transitionState).toBe(1);
        expect(usesGlobeMesh(contextFor(globe))).toBe(true);
    });

    test('globe transitioned out to mercator does not', () => {
        const globe = evaluated(new GlobeProjection({type: ['interpolate', ['linear'], ['zoom'], 4, 'vertical-perspective', 6, 'mercator']} as any, {}), 12);
        expect(globe.transitionState).toBe(0);
        expect(usesGlobeMesh(contextFor(globe))).toBe(false);
    });

    test('Equal Earth adaptive mid-blend does not, although it reports a nonzero transitionState', () => {
        const adaptive = evaluated(new EqualEarthAdaptiveProjection({type: ['interpolate', ['linear'], ['zoom'], 4, 'equal-earth', 6, 'mercator']} as any, {}), 5);
        expect(adaptive.transitionState).toBeGreaterThan(0);
        expect(adaptive.transitionState).toBeLessThan(1);
        expect(contextFor(adaptive).data.isRenderingGlobe).toBe(true);
        expect(usesGlobeMesh(contextFor(adaptive))).toBe(false);
    });

    test('Equal Earth adaptive at full Equal Earth does not', () => {
        const adaptive = evaluated(new EqualEarthAdaptiveProjection({type: ['interpolate', ['linear'], ['zoom'], 4, 'equal-earth', 6, 'mercator']} as any, {}), 2);
        expect(adaptive.transitionState).toBe(1);
        expect(usesGlobeMesh(contextFor(adaptive))).toBe(false);
    });
});
