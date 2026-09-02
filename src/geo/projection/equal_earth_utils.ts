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
 * `lambda0` (Stage B step 8, default 0 for pre-existing call sites): the
 * central meridian, passed straight through to `equalEarthWorldFromLngLat` —
 * see that function's doc comment and
 * docs/resources/2026-07-20-stage-b-step8-dynamic-lambda0-design.md (outer
 * project) for the full design.
 * @param worldSize - Equal Earth world size computed from zoom level and tile size.
 * @param lnglat - The location to convert.
 * @param lambda0 - The central meridian in degrees (≡ `center.lng` at every
 * real call site).
 * @returns Point
 */
export function projectToEqualEarthWorldCoordinates(worldSize: number, lnglat: LngLat, lambda0: number = 0): Point {
    const {x, y} = equalEarthWorldFromLngLat(lnglat.lng, lnglat.lat, lambda0);
    return new Point(x * worldSize, y * worldSize);
}

/**
 * Convert from world coordinates (unit-square Equal Earth coordinates scaled
 * by world size) to LngLat.
 *
 * Inverse of `projectToEqualEarthWorldCoordinates`, including its unit-square
 * y-down world convention (see the note there).
 * `lambda0` (Stage B step 8, default 0): see `projectToEqualEarthWorldCoordinates`
 * above.
 * @param worldSize - Equal Earth world size computed from zoom level and tile size.
 * @param point - World coordinate.
 * @param lambda0 - The central meridian in degrees (≡ `center.lng` at every
 * real call site).
 * @returns LngLat
 */
export function unprojectFromEqualEarthWorldCoordinates(worldSize: number, point: Point, lambda0: number = 0): LngLat {
    const {lng, lat} = lngLatFromEqualEarthWorld(point.x / worldSize, point.y / worldSize, lambda0);
    return new LngLat(lng, lat);
}

const PITCHED_FOOTPRINT_SAFETY_MARGIN_DEGREES = 8;

/**
 * How much farther, as a ratio, the ground footprint of a pitched camera
 * reaches than flat-camera math assumes (2026-07-24 pitch/void constrain
 * round; hoisted here 2026-09-02 so the covering-tiles window shares it).
 * The ray at the top of the screen leaves the camera at `pitch + halfFov`
 * from nadir — not just `pitch`, and ground distance grows with `tan`, not
 * `cos`, as that angle approaches the horizon — so the ratio is
 * `tan(pitch + halfFov) / tan(halfFov)`, clamped so a pitch approaching
 * (90° − halfFov) — looking at the literal horizon — can't blow up
 * unboundedly. Exact identity (factor 1) at pitch = 0.
 * @param pitchDegrees - Camera pitch in degrees.
 * @param fovInRadians - Full vertical field of view in radians.
 * @returns Multiplier ≥ 1 for flat-math screen half-extents.
 */
export function pitchedFootprintFactor(pitchDegrees: number, fovInRadians: number): number {
    if (pitchDegrees <= 0) return 1;
    const halfFov = fovInRadians / 2;
    const maxPitchRad = (90 - PITCHED_FOOTPRINT_SAFETY_MARGIN_DEGREES) * Math.PI / 180 - halfFov;
    const pitchRad = Math.min(Math.max(pitchDegrees * Math.PI / 180, 0), Math.max(0, maxPitchRad));
    return Math.tan(pitchRad + halfFov) / Math.tan(halfFov);
}
