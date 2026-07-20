import {describe, test, expect} from 'vitest';
import Point from '@mapbox/point-geometry';
import {LngLat} from '../lng_lat.ts';
import {EqualEarthTransform} from './equal_earth_transform.ts';

function createTransform(zoom: number = 3, center: LngLat = new LngLat(0, 0)): EqualEarthTransform {
    const transform = new EqualEarthTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 60, renderWorldCopies: false});
    transform.resize(500, 500);
    transform.setCenter(center);
    transform.setZoom(zoom);
    return transform;
}

describe('EqualEarthTransform', () => {
    describe('screen orientation (y-down world convention regression)', () => {
        // Phases 1-2 were internally consistent in the paper's y-up convention
        // and would have rendered the world upside down; these tests pin the
        // y-down seam so that regression cannot come back silently.
        test('north of center lands higher on screen (smaller y)', () => {
            const transform = createTransform();
            const centerScreen = transform.locationToScreenPoint(new LngLat(0, 0));
            const northScreen = transform.locationToScreenPoint(new LngLat(0, 45));
            expect(northScreen.y).toBeLessThan(centerScreen.y);
        });

        test('east of center lands further right on screen (larger x)', () => {
            const transform = createTransform();
            const centerScreen = transform.locationToScreenPoint(new LngLat(0, 0));
            const eastScreen = transform.locationToScreenPoint(new LngLat(45, 0));
            expect(eastScreen.x).toBeGreaterThan(centerScreen.x);
        });

        test('map center lands on the screen center', () => {
            const transform = createTransform();
            const p = transform.locationToScreenPoint(new LngLat(0, 0));
            expect(p.x).toBeCloseTo(250, 6);
            expect(p.y).toBeCloseTo(250, 6);
        });
    });

    describe('screen <-> location round trip', () => {
        // Equator, mid-latitudes, high latitudes, both hemispheres. Exact
        // poles are deliberately absent: they are far off-screen at these
        // views and screen round-trips of off-screen points are not
        // meaningful.
        const locations = [
            new LngLat(0, 0),
            new LngLat(30, 45),
            new LngLat(-30, 45),
            new LngLat(30, -45),
            new LngLat(-120, 60),
            new LngLat(150, -60),
            new LngLat(60, 80),
        ];

        test('locationToScreenPoint then screenPointToLocation returns the original', () => {
            const transform = createTransform();
            for (const location of locations) {
                const roundTripped = transform.screenPointToLocation(transform.locationToScreenPoint(location));
                expect(roundTripped.lng).toBeCloseTo(location.lng, 8);
                expect(roundTripped.lat).toBeCloseTo(location.lat, 8);
            }
        });

        test('round trip also holds with a non-origin center', () => {
            const transform = createTransform(4, new LngLat(20, 30));
            for (const location of locations) {
                const roundTripped = transform.screenPointToLocation(transform.locationToScreenPoint(location));
                expect(roundTripped.lng).toBeCloseTo(location.lng, 8);
                expect(roundTripped.lat).toBeCloseTo(location.lat, 8);
            }
        });
    });

    describe('setLocationAtPoint', () => {
        test('places the location at the requested screen point', () => {
            const transform = createTransform(4);
            transform.setLocationAtPoint(new LngLat(13, 10), new Point(15, 45));
            const p = transform.locationToScreenPoint(new LngLat(13, 10));
            expect(p.x).toBeCloseTo(15, 6);
            expect(p.y).toBeCloseTo(45, 6);
            const location = transform.screenPointToLocation(new Point(15, 45));
            expect(location.lng).toBeCloseTo(13, 8);
            expect(location.lat).toBeCloseTo(10, 8);
        });
    });
});
