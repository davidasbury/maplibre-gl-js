import type Point from '@mapbox/point-geometry';
import {LngLat, type LngLatLike} from '../lng_lat.ts';
import {cameraForBoxAndBearing, type CameraForBoxAndBearingHandlerResult, type EaseToHandlerResult, type EaseToHandlerOptions, type FlyToHandlerResult, type FlyToHandlerOptions, type ICameraHelper, type MapControlsDeltas, updateRotation} from './camera_helper.ts';
import {normalizeCenter} from '../transform_helper.ts';
import {rollPitchBearingEqual, scaleZoom, zoomScale} from '../../util/util.ts';
import {getMercatorHorizon} from './mercator_utils.ts';
import {projectToEqualEarthWorldCoordinates, unprojectFromEqualEarthWorldCoordinates} from './equal_earth_utils.ts';
import {interpolates} from '@maplibre/maplibre-gl-style-spec';

import type {IReadonlyTransform, ITransform} from '../transform_interface.ts';
import type {CameraForBoundsOptions} from '../../ui/camera.ts';
import type {PaddingOptions} from '../edge_insets.ts';
import type {LngLatBounds} from '../lng_lat_bounds.ts';

/**
 * @internal
 * Stage B step 8: rewired for dynamic λ0 (see
 * docs/resources/2026-07-20-stage-b-step8-dynamic-lambda0-design.md, outer
 * project). `handleEaseTo`/`handleFlyTo` pass `tr.center.lng` at call time --
 * known accepted wart (per the design doc): `from`/`delta` are computed once
 * in the then-current rotating frame, so long eases may follow slightly odd
 * paths, but they still land exactly, because every animation frame ends in
 * `setLocationAtPoint`, which solves in the live (current) frame regardless
 * of what frame `from`/`delta` were captured in. `getMercatorHorizon` and
 * `cameraForBoxAndBearing` (via `camera_helper.ts`) are reused unchanged from
 * mercator: neither has an Equal Earth-specific equivalent yet, and both are
 * placeholders with no real consequence until pitch/bounds-fitting are
 * actually rewired for this projection's shape.
 */
export class EqualEarthCameraHelper implements ICameraHelper {
    get useGlobeControls(): boolean { return false; }

    handlePanInertia(pan: Point, transform: IReadonlyTransform): {
        easingCenter: LngLat;
        easingOffset: Point;
    } {
        // Reduce the offset so that it never goes past the horizon. If it goes past
        // the horizon, the pan direction is opposite of the intended direction.
        const offsetLength = pan.mag();
        const pixelsToHorizon = Math.abs(getMercatorHorizon(transform));
        const horizonFactor = 0.75; // Must be < 1 to prevent the offset from crossing the horizon
        const offsetAsPoint = pan.mult(Math.min(pixelsToHorizon * horizonFactor / offsetLength, 1.0));
        return {
            easingOffset: offsetAsPoint,
            easingCenter: transform.center,
        };
    }

    handleMapControlsRollPitchBearingZoom(deltas: MapControlsDeltas, tr: ITransform): void {
        if (deltas.bearingDelta) tr.setBearing(tr.bearing + deltas.bearingDelta);
        if (deltas.pitchDelta) tr.setPitch(tr.pitch + deltas.pitchDelta);
        if (deltas.rollDelta) tr.setRoll(tr.roll + deltas.rollDelta);
        if (deltas.zoomDelta) tr.setZoom(tr.zoom + deltas.zoomDelta);
    }

    handleMapControlsPan(deltas: MapControlsDeltas, tr: ITransform, preZoomAroundLoc: LngLat): void {
        // If we are rotating about the center point, there is no need to update the transform center. Doing so causes
        // a small amount of drift of the center point, especially when pitch is close to 90 degrees.
        // In this case, return early.
        if (deltas.around.distSqr(tr.centerPoint) < 1.0e-2) {
            return;
        }
        tr.setLocationAtPoint(preZoomAroundLoc, deltas.around);
    }

    cameraForBoxAndBearing(options: CameraForBoundsOptions, padding: PaddingOptions, bounds: LngLatBounds, bearing: number, tr: IReadonlyTransform): CameraForBoxAndBearingHandlerResult {
        return cameraForBoxAndBearing(options, padding, bounds, bearing, tr);
    }

    handleJumpToCenterZoom(tr: ITransform, options: { zoom?: number; center?: LngLatLike }): void {
        // Zoom & center handling.
        const optionsZoom = typeof options.zoom !== 'undefined';

        const zoom = optionsZoom ? +options.zoom : tr.zoom;
        if (tr.zoom !== zoom) {
            tr.setZoom(+options.zoom);
        }

        if (options.center !== undefined) {
            tr.setCenter(LngLat.convert(options.center));
        }
    }

    handleEaseTo(tr: ITransform, options: EaseToHandlerOptions): EaseToHandlerResult {
        const startZoom = tr.zoom;
        const startPadding = tr.padding;
        const startEulerAngles = {roll: tr.roll, pitch: tr.pitch, bearing: tr.bearing};
        const endRoll = options.roll === undefined ? tr.roll : options.roll;
        const endPitch = options.pitch === undefined ? tr.pitch : options.pitch;
        const endBearing = options.bearing === undefined ? tr.bearing : options.bearing;
        const endEulerAngles = {roll: endRoll, pitch: endPitch, bearing: endBearing};

        const optionsZoom = typeof options.zoom !== 'undefined';

        const doPadding = !tr.isPaddingEqual(options.padding);

        let isZooming = false;

        const zoom = optionsZoom ? +options.zoom : tr.zoom;

        let pointAtOffset = tr.centerPoint.add(options.offsetAsPoint);
        const locationAtOffset = tr.screenPointToLocation(pointAtOffset);
        const {center, zoom: endZoom} = tr.applyConstrain(
            LngLat.convert(options.center || locationAtOffset),
            zoom ?? startZoom
        );
        normalizeCenter(tr, center);

        // lambda0 = tr.center.lng captured once, at call time, in the
        // then-current (pre-animation) frame -- see the class doc comment.
        // `normalizeCenter` above already put `center` within 180 degrees of
        // this same lambda0, so `delta` is always the short way around.
        const lambda0 = tr.center.lng;
        const from = projectToEqualEarthWorldCoordinates(tr.worldSize, locationAtOffset, lambda0);
        const delta = projectToEqualEarthWorldCoordinates(tr.worldSize, center, lambda0).sub(from);

        const finalScale = zoomScale(endZoom - startZoom);
        isZooming = (endZoom !== startZoom);

        const easeFunc = (k: number) => {
            if (isZooming) {
                tr.setZoom(interpolates.number(startZoom, endZoom, k));
            }
            if (!rollPitchBearingEqual(startEulerAngles, endEulerAngles)) {
                updateRotation({
                    startEulerAngles,
                    endEulerAngles,
                    tr,
                    k,
                    useSlerp: startEulerAngles.roll != endEulerAngles.roll});
            }
            if (doPadding) {
                tr.interpolatePadding(startPadding, options.padding, k);
                // When padding is being applied, Transform.centerPoint is changing continuously,
                // thus we need to recalculate offsetPoint every frame
                pointAtOffset = tr.centerPoint.add(options.offsetAsPoint);
            }

            if (options.around) {
                tr.setLocationAtPoint(options.around, options.aroundPoint);
            } else {
                const scale = zoomScale(tr.zoom - startZoom);
                const base = endZoom > startZoom ?
                    Math.min(2, finalScale) :
                    Math.max(0.5, finalScale);
                const speedup = Math.pow(base, 1 - k);
                const newCenter = unprojectFromEqualEarthWorldCoordinates(tr.worldSize, from.add(delta.mult(k * speedup)).mult(scale), lambda0);
                tr.setLocationAtPoint(tr.renderWorldCopies ? newCenter.wrap() : newCenter, pointAtOffset);
            }
        };

        return {
            easeFunc,
            isZooming,
            elevationCenter: center,
        };
    }

    handleFlyTo(tr: ITransform, options: FlyToHandlerOptions): FlyToHandlerResult {
        const optionsZoom = typeof options.zoom !== 'undefined';

        const startZoom = tr.zoom;

        // Obtain target center and zoom
        const constrained = tr.applyConstrain(
            LngLat.convert(options.center || options.locationAtOffset),
            optionsZoom ? +options.zoom : startZoom
        );
        const targetCenter = constrained.center;
        const targetZoom = constrained.zoom;

        normalizeCenter(tr, targetCenter);

        // See handleEaseTo's comment: lambda0 captured once, at call time;
        // normalizeCenter already put targetCenter within 180 degrees of it.
        const lambda0 = tr.center.lng;
        const startWorldSize = tr.worldSize;
        const from = projectToEqualEarthWorldCoordinates(startWorldSize, options.locationAtOffset, lambda0);
        const delta = projectToEqualEarthWorldCoordinates(startWorldSize, targetCenter, lambda0).sub(from);

        const pixelPathLength = delta.mag();

        const scaleOfZoom = zoomScale(targetZoom - startZoom);

        const requestedMinZoom = typeof options.minZoom !== 'undefined' ? +options.minZoom : tr.minZoom;
        const effectiveMinZoom = Math.max(requestedMinZoom, tr.minZoom);
        const minZoomPreConstrain = Math.min(effectiveMinZoom, startZoom, targetZoom);
        const minZoom = tr.applyConstrain(targetCenter, minZoomPreConstrain).zoom;
        const scaleOfMinZoom = zoomScale(minZoom - startZoom);

        const easeFunc = (k: number, scale: number, centerFactor: number, pointAtOffset: Point) => {
            tr.setZoom(k === 1 ? targetZoom : startZoom + scaleZoom(scale));
            const newCenter = k === 1
                ? targetCenter
                : unprojectFromEqualEarthWorldCoordinates(startWorldSize, from.add(delta.mult(centerFactor)), lambda0);
            tr.setLocationAtPoint(tr.renderWorldCopies ? newCenter.wrap() : newCenter, pointAtOffset);
        };

        return {
            easeFunc,
            scaleOfZoom,
            targetCenter,
            scaleOfMinZoom,
            pixelPathLength,
        };
    }
}
