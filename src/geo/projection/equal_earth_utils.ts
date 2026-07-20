import Point from '@mapbox/point-geometry';
import {LngLat} from '../lng_lat.ts';
import {equalEarthWorldFromLngLat, lngLatFromEqualEarthWorld} from '../equal_earth_coordinate.ts';

/**
 * Convert from LngLat to world coordinates (unit-square Equal Earth
 * coordinates scaled by world size).
 *
 * The unit convention matches `MercatorCoordinate`'s fraction-of-world world:
 * content lives inside the unit square (before worldSize scaling), (0.5, 0.5)
 * is (0°, 0°), and y is DOWN (north maps to smaller world y) — the
 * screen-oriented world space MapLibre's whole matrix pipeline
 * (`_calcMatrices`' `[1,-1,1]` flip, bearing/roll signs, centerOffset signs)
 * is built for. A single uniform scale (`EQUAL_EARTH_WORLD_EXTENT`) is used
 * for both axes to preserve the equal-area property, so world-y spans only
 * ~[0.2566, 0.7434] of the square. `equal_earth_coordinate.ts`'s paper-
 * convention functions stay y-up/unscaled; `equalEarthWorldFromLngLat`
 * carries the whole conversion at this seam.
 *
 * Unlike `projectToWorldCoordinates` (mercator), this does not clamp latitude first:
 * the Equal Earth forward math is well-defined at the poles themselves (see its own tests/fixture).
 * @param worldSize - Equal Earth world size computed from zoom level and tile size.
 * @param lnglat - The location to convert.
 * @returns Point
 */
export function projectToEqualEarthWorldCoordinates(worldSize: number, lnglat: LngLat): Point {
    const {x, y} = equalEarthWorldFromLngLat(lnglat.lng, lnglat.lat);
    return new Point(x * worldSize, y * worldSize);
}

/**
 * Convert from world coordinates (unit-square Equal Earth coordinates scaled
 * by world size) to LngLat.
 *
 * Inverse of `projectToEqualEarthWorldCoordinates`, including its unit-square
 * y-down world convention (see the note there).
 * @param worldSize - Equal Earth world size computed from zoom level and tile size.
 * @param point - World coordinate.
 * @returns LngLat
 */
export function unprojectFromEqualEarthWorldCoordinates(worldSize: number, point: Point): LngLat {
    const {lng, lat} = lngLatFromEqualEarthWorld(point.x / worldSize, point.y / worldSize);
    return new LngLat(lng, lat);
}
