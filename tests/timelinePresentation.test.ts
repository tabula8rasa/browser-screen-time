import { describe, expect, it } from 'vitest';
import { axisLabel, HistoryDay, smoothIntervals, TimelineGroup, TimelineSession, timelineRows } from '../src/scripts/timelinePresentation';
const base = Date.UTC(2026, 9, 7);
const group: TimelineGroup = { dayKey: '2026-10-07', timeZone: 'UTC', dayStart: base, dayEnd: base + 86400000, status: 'partial' };
function session(id: number, domainId: number, start: number, end: number): TimelineSession { return { ...group, id, domainId, start: base + start, end: base + end }; }
function history(sessions: TimelineSession[]): HistoryDay { return { status: 'partial', sessions, groups: [group], domains: ['a', 'b', 'c', 'd', 'e', 'f'].map((domain, id) => ({ domain, id: id + 1 })) }; }
describe('timeline raw data and presentation isolation', () => {
    it('ranks by raw session duration, merges brief same-site gaps only visually, and restores exact intervals at zoom', () => {
        const data = history([session(1, 1, 0, 1200000), session(2, 2, 1200000, 1320000), session(3, 1, 1320000, 3000000)]);
        const copy = structuredClone(data);
        const full = timelineRows(data, group, 1), detailed = timelineRows(data, group, 4);
        expect(full[0].domain).toBe('a'); expect(full[0].milliseconds).toBe(2880000);
        expect(full[0].intervals).toEqual([{ domain: 'a', start: base, end: base + 3000000 }]);
        expect(detailed[0].intervals).toHaveLength(2); expect(detailed[0].milliseconds).toBe(full[0].milliseconds);
        expect(timelineRows(data, group, 2)[0].intervals).toHaveLength(2);
        expect(full[1].intervals).toEqual([{ domain: 'b', start: base + 1200000, end: base + 1320000 }]); expect(data).toEqual(copy);
    });
    it('keeps Other domains separate and uses hostname tie-breaking for Top4', () => {
        const data = history([session(1, 6, 0, 60000), session(2, 5, 60000, 120000), session(3, 4, 120000, 180000), session(4, 3, 180000, 240000), session(5, 2, 240000, 300000), session(6, 1, 300000, 360000)]);
        const rows = timelineRows(data, group, 1);
        expect(rows.slice(0, 4).map(row => row.domain)).toEqual(['a', 'b', 'c', 'd']);
        expect(rows[4].milliseconds).toBe(120000); expect(rows[4].intervals.map(interval => interval.domain)).toEqual(['f', 'e']);
    });
    it('selects immutable calendar identity and excludes provisional rows and unknown domains', () => {
        const other = { ...session(2, 1, 10, 20), timeZone: 'Asia/Tbilisi' };
        const data = history([session(1, 1, 0, 0), other, session(3, 999, 20, 30)]);
        expect(timelineRows(data, group, 1).every(row => row.milliseconds === 0)).toBe(true);
    });
    it('clips to group bounds without changing raw intervals', () => {
        const data = history([session(1, 1, -10, 20)]);
        expect(timelineRows(data, group, 4)[0].milliseconds).toBe(20); expect(data.sessions[0].start).toBe(base - 10);
    });
    it('labels repeated DST hours with offset and preserves a real 25-hour axis', () => {
        const dst = { ...group, timeZone: 'America/New_York', dayKey: '2026-11-01', dayStart: Date.UTC(2026, 10, 1, 4), dayEnd: Date.UTC(2026, 10, 2, 5) };
        expect(axisLabel(Date.UTC(2026, 10, 1, 5), dst)).toContain('GMT-4');
        expect(axisLabel(Date.UTC(2026, 10, 1, 6), dst)).toContain('GMT-5');
        expect(axisLabel(dst.dayEnd, dst)).toBe('24:00'); expect(dst.dayEnd - dst.dayStart).toBe(25 * 3600000);
    });
    it('zero smoothing preserves even adjacent raw sessions', () => {
        expect(smoothIntervals([{ domain: 'a', start: 0, end: 10 }, { domain: 'a', start: 10, end: 20 }], 0)).toHaveLength(2);
    });
});
