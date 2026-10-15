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
        const full = timelineRows(data, group, 1, 120), detailed = timelineRows(data, group, 4);
        expect(full[0].domain).toBe('a'); expect(full[0].milliseconds).toBe(2880000);
        expect(full[0].intervals).toEqual([{ domain: 'a', start: base, end: base + 3000000 }]);
        expect(detailed[0].intervals).toHaveLength(2); expect(detailed[0].milliseconds).toBe(full[0].milliseconds);
        expect(timelineRows(data, group, 2, 120)[0].intervals).toHaveLength(2);
        expect(full[1].intervals).toEqual([{ domain: 'b', start: base + 1200000, end: base + 1320000 }]); expect(data).toEqual(copy);
    });
    it('defaults to 800 seconds at full day and reduces smoothing when zoomed', () => {
        const data = history([session(1, 1, 0, 60000), session(2, 1, 860000, 920000)]);
        expect(timelineRows(data, group, 1)[0].intervals).toHaveLength(1);
        expect(timelineRows(data, group, 2)[0].intervals).toHaveLength(2);
        expect(timelineRows(data, group, 4)[0].intervals).toHaveLength(2);
        expect(timelineRows(data, group, 1)[0].milliseconds).toBe(120000);
    });
    it('uses the selected threshold while retaining raw totals and detailed zoom', () => {
        const data = history([session(1, 1, 0, 60000), session(2, 1, 150000, 210000)]);
        const copy = structuredClone(data);
        expect(timelineRows(data, group, 1, 89)[0].intervals).toHaveLength(2);
        expect(timelineRows(data, group, 1, 90)[0].intervals).toHaveLength(1);
        expect(timelineRows(data, group, 2, 90)[0].intervals).toHaveLength(2);
        expect(timelineRows(data, group, 1, 0)[0].intervals).toHaveLength(2);
        expect(timelineRows(data, group, 4, 3600)[0].intervals).toHaveLength(2);
        expect(timelineRows(data, group, 1, 3600)[0].milliseconds).toBe(120000);
        expect(data).toEqual(copy);
    });
    it('smooths Other as one site and restores separate domains at detailed zoom', () => {
        const data = history([session(1, 6, 0, 60000), session(2, 5, 60000, 120000), session(3, 4, 120000, 180000), session(4, 3, 180000, 240000), session(5, 2, 240000, 300000), session(6, 1, 300000, 360000)]);
        const rows = timelineRows(data, group, 1);
        expect(rows.slice(0, 4).map(row => row.domain)).toEqual(['a', 'b', 'c', 'd']);
        expect(rows[4].milliseconds).toBe(120000);
        expect(rows[4].intervals).toEqual([{ domain: 'Other', start: base, end: base + 120000 }]);
        expect(timelineRows(data, group, 2)[4].intervals).toEqual(rows[4].intervals);
        for (const zoom of [4, 8]) {
            const raw = timelineRows(data, group, zoom)[4];
            expect(raw.intervals).toEqual([{ domain: 'f', start: base, end: base + 60000 }, { domain: 'e', start: base + 60000, end: base + 120000 }]);
            expect(raw.milliseconds).toBe(rows[4].milliseconds);
        }
        expect(timelineRows(data, group, 1, 0)[4].intervals).toHaveLength(2);
        expect(data.sessions[0].domainId).toBe(6);
    });
    it('applies the chosen gap threshold across different Other sites without altering raw history', () => {
        const data = history([session(1, 1, 300000, 600000), session(2, 2, 600000, 900000), session(3, 3, 900000, 1200000), session(4, 4, 1200000, 1500000), session(5, 5, 0, 60000), session(6, 6, 150000, 210000)]);
        const copy = structuredClone(data);
        expect(timelineRows(data, group, 1, 89)[4].intervals).toHaveLength(2);
        expect(timelineRows(data, group, 1, 90)[4].intervals).toEqual([{ domain: 'Other', start: base, end: base + 210000 }]);
        expect(timelineRows(data, group, 2, 90)[4].intervals).toHaveLength(2);
        expect(timelineRows(data, group, 4, 3600)[4].intervals.map(interval => interval.domain)).toEqual(['e', 'f']);
        expect(timelineRows(data, group, 1, 90)[4].milliseconds).toBe(120000);
        expect(data).toEqual(copy);
    });
    it('hides only isolated sessions below five minutes after smoothing, keeping short connected clusters', () => {
        const data = history([session(1, 1, 0, 60000), session(2, 1, 90000, 150000), session(3, 1, 3600000, 3660000), session(4, 1, 7200000, 7500000)]);
        const copy = structuredClone(data);
        const filtered = timelineRows(data, group, 1, 30, true)[0];
        expect(filtered.intervals).toEqual([
            { domain: 'a', start: base, end: base + 150000 },
            { domain: 'a', start: base + 7200000, end: base + 7500000 }
        ]);
        expect(filtered.milliseconds).toBe(timelineRows(data, group, 1, 30)[0].milliseconds);
        for (const [zoom, smoothing] of [[2, 30], [4, 800], [1, 0]]) {
            expect(timelineRows(data, group, zoom, smoothing, true)[0].intervals).toEqual([{ domain: 'a', start: base + 7200000, end: base + 7500000 }]);
        }
        expect(data).toEqual(copy);
    });
    it('hides unrelated short Other sites at full day and 2x before grouping them for display', () => {
        const data = history([session(1, 1, 300000, 900000), session(2, 2, 900000, 1500000), session(3, 3, 1500000, 2100000), session(4, 4, 2100000, 2700000), session(5, 5, 0, 60000), session(6, 6, 150000, 210000)]);
        const copy = structuredClone(data);
        for (const zoom of [1, 2, 4]) {
            expect(timelineRows(data, group, zoom, 800, true)[4].intervals).toEqual([]);
            expect(timelineRows(data, group, zoom, 800, true)[4].milliseconds).toBe(120000);
        }
        expect(timelineRows(data, group, 1, 800)[4].intervals).toHaveLength(1);
        expect(data).toEqual(copy);
    });
    it('retains short Other sessions connected to the same site while hiding unrelated neighbors', () => {
        const data = history([session(1, 1, 900000, 1500000), session(2, 2, 1500000, 2100000), session(3, 3, 2100000, 2700000), session(4, 4, 2700000, 3300000), session(5, 5, 0, 60000), session(6, 5, 150000, 210000), session(7, 6, 250000, 310000)]);
        for (const zoom of [1, 2]) {
            expect(timelineRows(data, group, zoom, 800, true)[4].intervals).toEqual([{ domain: 'Other', start: base, end: base + 210000 }]);
        }
        expect(timelineRows(data, group, 4, 800, true)[4].intervals).toEqual([]);
        expect(timelineRows(data, group, 1, 800, true)[4].milliseconds).toBe(180000);
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
