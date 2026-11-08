import {ProjectionDefinition, createExpression, latest, type StylePropertySpecification} from '@maplibre/maplibre-gl-style-spec';
import {warnOnce} from '../../util/util.ts';
import {MercatorProjection} from './mercator_projection.ts';
import {createMercatorTransform} from './mercator_transform.ts';
import {MercatorCameraHelper} from './mercator_camera_helper.ts';
import {GlobeProjection} from './globe_projection.ts';
import {createGlobeTransform} from './globe_transform.ts';
import {GlobeCameraHelper} from './globe_camera_helper.ts';
import {VerticalPerspectiveCameraHelper} from './vertical_perspective_camera_helper.ts';
import {createVerticalPerspectiveTransform} from './vertical_perspective_transform.ts';
import {VerticalPerspectiveProjection} from './vertical_perspective_projection.ts';
import {EqualEarthProjection} from './equal_earth_projection.ts';
import {EqualEarthTransform} from './equal_earth_transform.ts';
import {EqualEarthCameraHelper} from './equal_earth_camera_helper.ts';
import {EqualEarthAdaptiveProjection} from './equal_earth_adaptive_projection.ts';
import {EqualEarthAdaptiveTransform} from './equal_earth_adaptive_transform.ts';
import {EqualEarthAdaptiveCameraHelper} from './equal_earth_adaptive_camera_helper.ts';
import {CRSWorldCoordinateHelper} from './crs.ts';
import {getRegisteredProjection} from './projection_crud.ts';

import type {ProjectionSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {Projection} from './projection.ts';
import type {ITransform, TransformConstrainFunction} from '../transform_interface.ts';
import type {ICameraHelper} from './camera_helper.ts';

export function createProjectionFromName(name: ProjectionSpecification['type'], transformConstrain: TransformConstrainFunction | undefined, globalState: Record<string, any>): {
    projection: Projection;
    transform: ITransform;
    cameraHelper: ICameraHelper;
} {
    const transformOptions = {constrainOverride: transformConstrain};
    if (Array.isArray(name)) {
        const registeredName = findRegisteredProjectionName(name);
        if (registeredName) {
            warnOnce(`Projection expressions cannot use the registered projection "${registeredName}", which only works as a plain name. Falling back to the globe projection.`);
        }
        // Stage C: a projection expression that can produce equal-earth
        // routes to the adaptive Equal Earth composite; anything else keeps
        // the globe composite (the pre-existing behavior for
        // vertical-perspective/mercator expressions).
        if (routesToEqualEarth(name, globalState)) {
            const eeAdaptiveProjection = new EqualEarthAdaptiveProjection({type: name}, globalState);
            return {
                projection: eeAdaptiveProjection,
                transform: new EqualEarthAdaptiveTransform(transformOptions),
                cameraHelper: new EqualEarthAdaptiveCameraHelper(eeAdaptiveProjection),
            };
        }
        const globeProjection = new GlobeProjection({type: name}, globalState);
        return {
            projection: globeProjection,
            transform: createGlobeTransform(transformOptions),
            cameraHelper: new GlobeCameraHelper(globeProjection),
        };
    }
    const registered = getRegisteredProjection(name);
    if (registered) {
        const worldCoordinateHelper = new CRSWorldCoordinateHelper(registered);
        return {
            projection: new MercatorProjection(worldCoordinateHelper),
            transform: createMercatorTransform({...transformOptions, worldCoordinateHelper}),
            cameraHelper: new MercatorCameraHelper(),
        };
    }
    switch (name) {
        case 'mercator':
        {
            return {
                projection: new MercatorProjection(),
                transform: createMercatorTransform(transformOptions),
                cameraHelper: new MercatorCameraHelper(),
            };
        }
        case 'globe':
        {
            const globeProjection = new GlobeProjection({type: [
                'interpolate',
                ['linear'],
                ['zoom'],
                11,
                'vertical-perspective',
                12,
                'mercator'
            ]}, {});
            return {
                projection: globeProjection,
                transform: createGlobeTransform(transformOptions),
                cameraHelper: new GlobeCameraHelper(globeProjection),
            };
        }
        case 'vertical-perspective':
        {
            return {
                projection: new VerticalPerspectiveProjection(),
                transform: createVerticalPerspectiveTransform(transformOptions),
                cameraHelper: new VerticalPerspectiveCameraHelper(),
            };
        }
        case 'equal-earth':
        {
            return {
                projection: new EqualEarthProjection(),
                transform: new EqualEarthTransform(transformOptions),
                cameraHelper: new EqualEarthCameraHelper(),
            };
        }
        case 'equal-earth-adaptive':
        {
            // The adaptive preset, exactly the way 'globe' is a preset of
            // vertical-perspective->mercator: pure Equal Earth below z4,
            // pure mercator above z6 (Mapbox v2.6 shipped ~5-6; tuning is
            // plan step 13).
            const eeAdaptiveProjection = new EqualEarthAdaptiveProjection({type: [
                'interpolate',
                ['linear'],
                ['zoom'],
                4,
                'equal-earth',
                6,
                'mercator'
            ] as any}, {});
            return {
                projection: eeAdaptiveProjection,
                transform: new EqualEarthAdaptiveTransform(transformOptions),
                cameraHelper: new EqualEarthAdaptiveCameraHelper(eeAdaptiveProjection),
            };
        }
        default:
        {
            warnOnce(`Unknown projection name: ${name}. Falling back to mercator projection.`);
            return {
                projection: new MercatorProjection(),
                transform: createMercatorTransform(transformOptions),
                cameraHelper: new MercatorCameraHelper(),
            };
        }
    }
}

/**
 * The family a projection expression selects with the current global state: `'equal-earth'` or
 * `'vertical-perspective'`, or `undefined` when it is mercator, which both composites render. Each composite renders
 * only its own family (both blend to mercator), so the expression is evaluated at zoom 0, where the two differ: a
 * `["global-state", ...]` value or a `case` branch picks the family there. An expression that crosses families by
 * zoom renders in one family only.
 */
export function projectionFamily(expression: unknown[], globalState: Record<string, any>): 'equal-earth' | 'vertical-perspective' | undefined {
    // Evaluated without error handling so a failing expression doesn't log its fallback warning twice; the
    // composite's own evaluation logs it.
    let value: unknown;
    const parsed = createExpression(expression, 'projection.type', latest.projection.type as any as StylePropertySpecification, globalState);
    if (parsed.result === 'success') {
        try {
            value = parsed.value.evaluateWithoutErrorHandling({zoom: 0});
        } catch {
            value = undefined;
        }
    }
    const names = value instanceof ProjectionDefinition ? [value.from, value.to] : [value];
    if (names.includes('equal-earth')) return 'equal-earth';
    if (names.includes('vertical-perspective')) return 'vertical-perspective';
    return undefined;
}

/**
 * Whether a projection expression belongs on the adaptive Equal Earth composite rather than the globe composite: by
 * its family (see `projectionFamily`), or, when that is mercator, by whether it names equal-earth at all. `Style`
 * swaps composites when a global state change moves the expression to the other family.
 */
export function routesToEqualEarth(expression: unknown[], globalState: Record<string, any>): boolean {
    const family = projectionFamily(expression, globalState);
    return family ? family === 'equal-earth' : expression.flat(Infinity).includes('equal-earth');
}

/**
 * The first registered projection named anywhere in a projection expression, or `undefined` if it names none.
 */
function findRegisteredProjectionName(expression: unknown[]): string | undefined {
    return expression.flat(Infinity).find((item): item is string => typeof item === 'string' && getRegisteredProjection(item) !== undefined);
}
