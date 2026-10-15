import { describe, expect, it } from 'vitest';
import { boundViewport, panViewport, scaleViewport, selectViewport } from '../src/scripts/timelineViewport';
const hour = 3600000;
const day = { start: 0, end: 24 * hour };
describe('timeline mouse viewport', () => {
    it('selects either drag direction against the current viewport and clamps edges', () => {
        expect(selectViewport(day, 0.75, 0.25)).toEqual({ start: 6 * hour, end: 18 * hour });
        expect(selectViewport({ start: 6 * hour, end: 18 * hour }, 0.25, 0.75)).toEqual({ start: 9 * hour, end: 15 * hour });
        expect(selectViewport(day, -1, 2)).toEqual(day);
        expect(selectViewport(day, 0.5, 0.50001)).toBeNull();
    });
    it('doubles around the midpoint and clamps to the day without shrinking the window', () => {
        expect(scaleViewport({ start: 9 * hour, end: 15 * hour }, day, 2)).toEqual({ start: 6 * hour, end: 18 * hour });
        expect(scaleViewport({ start: 0, end: 6 * hour }, day, 2)).toEqual({ start: 0, end: 12 * hour });
        expect(scaleViewport(day, day, 2)).toEqual(day);
        const minute = { start: hour, end: hour + 60000 };
        expect(scaleViewport(minute, day, 0.5)).toEqual(minute);
        expect(boundViewport({ start: hour, end: hour + 1 }, day).end).toBe(hour + 60000);
    });
    it('pans without changing duration and respects both boundaries and DST day lengths', () => {
        const view = { start: 6 * hour, end: 12 * hour };
        expect(panViewport(view, day, 0.5)).toEqual({ start: 9 * hour, end: 15 * hour });
        expect(panViewport(view, day, -10)).toEqual({ start: 0, end: 6 * hour });
        expect(panViewport(view, day, 10)).toEqual({ start: 18 * hour, end: 24 * hour });
        for (const hours of [23, 25]) {
            const dst = { start: hour, end: (hours + 1) * hour };
            const half = selectViewport(dst, 0.25, 0.75)!;
            expect(half.end - half.start).toBe(hours * hour / 2);
            expect(scaleViewport(half, dst, 2)).toEqual(dst);
        }
    });
});
