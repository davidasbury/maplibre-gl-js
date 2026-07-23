import {warnOnce} from '../../util/util.ts';
import {MercatorProjection} from './mercator_projection.ts';
import {MercatorTransform} from './mercator_transform.ts';
import {MercatorCameraHelper} from './mercator_camera_helper.ts';
import {GlobeProjection} from './globe_projection.ts';
import {GlobeTransform} from './globe_transform.ts';
import {GlobeCameraHelper} from './globe_camera_helper.ts';
import {VerticalPerspectiveCameraHelper} from './vertical_perspective_camera_helper.ts';
import {VerticalPerspectiveTransform} from './vertical_perspective_transform.ts';
import {VerticalPerspectiveProjection} from './vertical_perspective_projection.ts';
import {EqualEarthProjection} from './equal_earth_projection.ts';
import {EqualEarthTransform} from './equal_earth_transform.ts';
import {EqualEarthCameraHelper} from './equal_earth_camera_helper.ts';
import {EqualEarthAdaptiveProjection} from './equal_earth_adaptive_projection.ts';
import {EqualEarthAdaptiveTransform} from './equal_earth_adaptive_transform.ts';
import {EqualEarthAdaptiveCameraHelper} from './equal_earth_adaptive_camera_helper.ts';

import type {ProjectionSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {Projection} from './projection.ts';
import type {ITransform, TransformConstrainFunction} from '../transform_interface.ts';
import type {ICameraHelper} from './camera_helper.ts';

export function createProjectionFromName(name: ProjectionSpecification['type'], transformConstrain?: TransformConstrainFunction): {
    projection: Projection;
    transform: ITransform;
    cameraHelper: ICameraHelper;
} {
    const transformOptions = {constrainOverride: transformConstrain};
    if (Array.isArray(name)) {
        // Stage C: a projection expression whose stops include equal-earth
        // routes to the adaptive Equal Earth composite; anything else keeps
        // the globe composite (the pre-existing behavior for
        // vertical-perspective/mercator expressions).
        if ((name as unknown[]).flat(20).includes('equal-earth')) {
            const eeAdaptiveProjection = new EqualEarthAdaptiveProjection({type: name});
            return {
                projection: eeAdaptiveProjection,
                transform: new EqualEarthAdaptiveTransform(transformOptions),
                cameraHelper: new EqualEarthAdaptiveCameraHelper(eeAdaptiveProjection),
            };
        }
        const globeProjection = new GlobeProjection({type: name});
        return {
            projection: globeProjection,
            transform: new GlobeTransform(transformOptions),
            cameraHelper: new GlobeCameraHelper(globeProjection),
        };
    }
    switch (name) {
        case 'mercator':
        {
            return {
                projection: new MercatorProjection(),
                transform: new MercatorTransform(transformOptions),
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
            ]});
            return {
                projection: globeProjection,
                transform: new GlobeTransform(transformOptions),
                cameraHelper: new GlobeCameraHelper(globeProjection),
            };
        }
        case 'vertical-perspective':
        {
            return {
                projection: new VerticalPerspectiveProjection(),
                transform: new VerticalPerspectiveTransform(transformOptions),
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
            ] as any});
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
                transform: new MercatorTransform(transformOptions),
                cameraHelper: new MercatorCameraHelper(),
            };
        }
    }
}
