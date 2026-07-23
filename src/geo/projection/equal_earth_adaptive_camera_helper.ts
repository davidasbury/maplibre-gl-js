import {MercatorCameraHelper} from './mercator_camera_helper.ts';
import {EqualEarthCameraHelper} from './equal_earth_camera_helper.ts';

import type Point from '@mapbox/point-geometry';
import type {CameraForBoxAndBearingHandlerResult, EaseToHandlerResult, EaseToHandlerOptions, FlyToHandlerResult, FlyToHandlerOptions, ICameraHelper, MapControlsDeltas} from './camera_helper.ts';
import type {LngLat, LngLatLike} from '../lng_lat.ts';
import type {IReadonlyTransform, ITransform} from '../transform_interface.ts';
import type {EqualEarthAdaptiveProjection} from './equal_earth_adaptive_projection.ts';
import type {CameraForBoundsOptions} from '../../ui/camera.ts';
import type {LngLatBounds} from '../lng_lat_bounds.ts';
import type {PaddingOptions} from '../edge_insets.ts';

/**
 * Stage C: camera helper for the adaptive Equal Earth projection, mirroring
 * `GlobeCameraHelper`'s delegation pattern. Both endpoints are planar, so
 * unlike globe there is no controls-mode switch — only which helper's pan
 * semantics apply: Equal Earth's (λ0-tracking drag) while any Equal Earth
 * is being rendered, mercator's in the pure-mercator regime. Blend-phase
 * pan feel (freezing λ0 as the blend leaves pure EE) is plan step 13.
 *
 * @internal
 */
export class EqualEarthAdaptiveCameraHelper implements ICameraHelper {
    private _projection: EqualEarthAdaptiveProjection;
    private _mercatorCameraHelper: MercatorCameraHelper;
    private _equalEarthCameraHelper: EqualEarthCameraHelper;

    constructor(projection: EqualEarthAdaptiveProjection) {
        this._projection = projection;
        this._mercatorCameraHelper = new MercatorCameraHelper();
        this._equalEarthCameraHelper = new EqualEarthCameraHelper();
    }

    get useGlobeControls(): boolean { return false; }

    get currentHelper(): ICameraHelper {
        return this._projection.useEqualEarthRendering ? this._equalEarthCameraHelper : this._mercatorCameraHelper;
    }

    handlePanInertia(pan: Point, transform: IReadonlyTransform): {
        easingCenter: LngLat;
        easingOffset: Point;
    } {
        return this.currentHelper.handlePanInertia(pan, transform);
    }

    handleMapControlsRollPitchBearingZoom(deltas: MapControlsDeltas, tr: ITransform): void {
        this.currentHelper.handleMapControlsRollPitchBearingZoom(deltas, tr);
    }

    handleMapControlsPan(deltas: MapControlsDeltas, tr: ITransform, preZoomAroundLoc: LngLat): void {
        this.currentHelper.handleMapControlsPan(deltas, tr, preZoomAroundLoc);
    }

    cameraForBoxAndBearing(options: CameraForBoundsOptions, padding: PaddingOptions, bounds: LngLatBounds, bearing: number, tr: ITransform): CameraForBoxAndBearingHandlerResult {
        return this.currentHelper.cameraForBoxAndBearing(options, padding, bounds, bearing, tr);
    }

    handleJumpToCenterZoom(tr: ITransform, options: { zoom?: number; center?: LngLatLike }): void {
        this.currentHelper.handleJumpToCenterZoom(tr, options);
    }

    handleEaseTo(tr: ITransform, options: EaseToHandlerOptions): EaseToHandlerResult {
        return this.currentHelper.handleEaseTo(tr, options);
    }

    handleFlyTo(tr: ITransform, options: FlyToHandlerOptions): FlyToHandlerResult {
        return this.currentHelper.handleFlyTo(tr, options);
    }
}
