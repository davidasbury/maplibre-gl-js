import Point from '@mapbox/point-geometry';
import {LngLat} from '../lng_lat.ts';
import {equalEarthXYFromLngLat, lngLatFromEqualEarthXY} from '../equal_earth_coordinate.ts';

/**
 * Convert from LngLat to world coordinates (Equal Earth coordinates scaled by world size).
 *
 * Unlike `projectToWorldCoordinates` (mercator), this does not clamp latitude first:
 * `equalEarthXYFromLngLat` is well-defined at the poles themselves (see its own tests/fixture).
 * @param worldSize - Equal Earth world size computed from zoom level and tile size.
 * @param lnglat - The location to convert.
 * @returns Point
 */
export function projectToEqualEarthWorldCoordinates(worldSize: number, lnglat: LngLat): Point {
    const {x, y} = equalEarthXYFromLngLat(lnglat.lng, lnglat.lat);
    return new Point(x * worldSize, y * worldSize);
}

/**
 * Convert from world coordinates (Equal Earth coordinates scaled by world size) to LngLat.
 * @param worldSize - Equal Earth world size computed from zoom level and tile size.
 * @param point - World coordinate.
 * @returns LngLat
 */
export function unprojectFromEqualEarthWorldCoordinates(worldSize: number, point: Point): LngLat {
    const {lng, lat} = lngLatFromEqualEarthXY(point.x / worldSize, point.y / worldSize);
    return new LngLat(lng, lat);
}
