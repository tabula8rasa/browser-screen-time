import { describe, expect, it, vi } from 'vitest';
vi.mock('webextension-polyfill', () => ({ default: {} }));
import { parseTransfer } from '../src/scripts/dataTransfer';
import Utils from '../src/scripts/utils';
const colors = ['#227C9D', '#17C3B2', '#FFCB77', '#FE6D73'];
const day = (n = 1) => ({ netTime: n, websiteTime: { 'a.test': n }, colors, otherColor: '#CFCFCF' });
const now = Date.UTC(2026, 9, 7, 12);
const identity = { dayKey: '2026-10-07', timeZone: 'UTC', dayStart: Date.UTC(2026, 9, 7), dayEnd: Date.UTC(2026, 9, 8) };
function backup() {
    return { format: 'browser-screen-time', formatVersion: 1, exportedAt: now, dailyAggregates: { '2026 10 7': day() }, history: {
        schemaVersion: 1, status: 'partial', recordingSince: identity.dayStart, domains: [{ id: 9, domain: 'a.test' }],
        sessions: [{ id: 7, domainId: 9, ...identity, start: identity.dayStart + 1000, end: identity.dayStart + 2000 }],
        observedWindows: [{ ...identity, start: identity.dayStart, end: now }], coverage: [], invalidDays: []
    } };
}
describe('backup static validation before mutation', () => {
    it.each([NaN, Infinity, -1])('rejects unsafe daily totals %s in legacy and full payloads', n => {
        expect(() => parseTransfer({ '2026 10 7': day(n) }, 'overwrite')).toThrow();
        const data = backup(); data.dailyAggregates['2026 10 7'] = day(n); expect(() => parseTransfer(data, 'overwrite', now)).toThrow();
    });
    it.each(['2026 2 29', '2026 13 1', '2026 0 1', '2026 10 32'])('rejects impossible date %s and filters unrelated keys', key => {
        expect(Utils.isDailyKey(key)).toBe(false); expect(() => parseTransfer({ [key]: day() }, 'overwrite')).toThrow();
        expect(Utils.isDailyKey('2024 2 29')).toBe(true); expect(Utils.isDailyKey('settings')).toBe(false);
    });
    it('roundtrips exact finalized data, omits unknown ownership, and rejects detailed merge', () => {
        const data = backup(); (data.history as any).open = { sessionId: 7 }; (data.history.sessions[0] as any).owner = 'old';
        const parsed = parseTransfer(data, 'overwrite', now); expect((parsed.history as any).open).toBeUndefined(); expect((parsed.history.sessions[0] as any).owner).toBeUndefined();
        expect(() => parseTransfer(data, 'merge', now)).toThrow('cannot be merged');
    });
    it.each(['overlap', 'zero', 'future', 'dangling', 'unnormalized', 'unknownOrigin'])('rejects malformed %s detail', kind => {
        const data = backup();
        if (kind === 'overlap') data.history.sessions.push({ ...data.history.sessions[0], id: 8 });
        if (kind === 'zero') data.history.sessions[0].end = data.history.sessions[0].start;
        if (kind === 'future') data.history.sessions[0].end = now + 3000;
        if (kind === 'dangling') data.history.sessions[0].domainId = 100;
        if (kind === 'unnormalized') data.history.domains[0].domain = 'A.TEST';
        if (kind === 'unknownOrigin') { data.history.status = 'available'; data.history.recordingSince = null; }
        expect(() => parseTransfer(data, 'overwrite', now)).toThrow();
    });
    it('rejects a mismatched declared timezone/date and truncated local day bounds', () => {
        const data = backup(); data.history.sessions[0].dayStart = 0; data.history.sessions[0].dayEnd = 86400000; data.history.sessions[0].start = 1000; data.history.sessions[0].end = 2000;
        expect(() => parseTransfer(data, 'overwrite', now)).toThrow('labels/bounds');
        const shortened = backup(); shortened.history.observedWindows[0].dayStart += 1000; shortened.history.observedWindows[0].start += 1000;
        expect(() => parseTransfer(shortened, 'overwrite', now)).toThrow('labels/bounds');
    });
    it.each([
        ['2026-03-08', 'America/New_York', '2026-03-08T05:00Z', '2026-03-09T04:00Z'],
        ['2026-11-01', 'America/New_York', '2026-11-01T04:00Z', '2026-11-02T05:00Z'],
        ['2026-10-07', 'Asia/Tbilisi', '2026-10-06T20:00Z', '2026-10-07T20:00Z'],
        ['2018-11-04', 'America/Sao_Paulo', '2018-11-04T03:00Z', '2018-11-05T02:00Z'],
        ['2011-12-31', 'Pacific/Apia', '2011-12-30T10:00Z', '2011-12-31T10:00Z']
    ])('accepts exact captured %s calendar in %s independent of importing device', (dayKey, timeZone, start, end) => {
        const data = backup(); const dayStart = Date.parse(start), dayEnd = Date.parse(end);
        const calendar = { dayKey, timeZone, dayStart, dayEnd };
        data.exportedAt = dayEnd; data.history.recordingSince = dayStart;
        data.history.sessions = [{ ...calendar, id: 1, domainId: 9, start: dayStart + 1000, end: dayStart + 2000 }];
        data.history.observedWindows = [{ ...calendar, start: dayStart, end: dayEnd }];
        expect(parseTransfer(data, 'overwrite', dayEnd).history.observedWindows[0]).toEqual({ ...calendar, start: dayStart, end: dayEnd });
    });
});
