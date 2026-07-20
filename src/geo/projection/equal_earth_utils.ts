import Point from '@mapbox/point-geometry';
import {LngLat} from '../lng_lat.ts';
import {equalEarthXYFromLngLat, lngLatFromEqualEarthXY} from '../equal_earth_coordinate.ts';

/**
 * Convert from LngLat to world coordinates (Equal Earth coordinates scaled by world size).
 *
 * The world convention here is y-DOWN (north maps to smaller world y), matching
 * mercator's screen-oriented world space: MapLibre's whole matrix pipeline
 * (`_calcMatrices`' `[1,-1,1]` flip, bearing/roll signs, centerOffset signs) is
 * built for a y-down world. `equal_earth_coordinate.ts` stays in the paper's
 * y-up convention, so the flip lives here at the seam.
 *
 * Unlike `projectToWorldCoordinates` (mercator), this does not clamp latitude first:
 * `equalEarthXYFromLngLat` is well-defined at the poles themselves (see its own tests/fixture).
 * @param worldSize - Equal Earth world size computed from zoom level and tile size.
 * @param lnglat - The location to convert.
 * @returns Point
 */
export function projectToEqualEarthWorldCoordinates(worldSize: number, lnglat: LngLat): Point {
    const {x, y} = equalEarthXYFromLngLat(lnglat.lng, lnglat.lat);
    return new Point(x * worldSize, -y * worldSize);
}

/**
 * Convert from world coordinates (Equal Earth coordinates scaled by world size) to LngLat.
 *
 * Inverse of `projectToEqualEarthWorldCoordinates`, including its y-down world
 * convention (see the note there).
 * @param worldSize - Equal Earth world size computed from zoom level and tile size.
 * @param point - World coordinate.
 * @returns LngLat
 */
export function unprojectFromEqualEarthWorldCoordinates(worldSize: number, point: Point): LngLat {
    const {lng, lat} = lngLatFromEqualEarthXY(point.x / worldSize, -point.y / worldSize);
    return new LngLat(lng, lat);
}
