import { describe, expect, it } from 'vitest';
import { calendarDate, calendarDayCount, calendarDays, changeLabel, dailySnapshot, dateInput, domainColor, formatDuration, parseDateInput, periodData, previousRange, shiftDay } from '../src/scripts/dashboardData';
const day = (sites: Record<string, number>) => ({ netTime: Object.values(sites).reduce((a, b) => a + b, 0), websiteTime: sites });
describe('dashboard saved aggregate semantics', () => {
    it('includes empty calendar days in average and compares exactly the preceding equal period', () => {
        const snapshot = dailySnapshot({ '2026 10 1': day({ a: 3600 }), '2026 10 7': day({ b: 7200 }), '2026 9 24': day({ a: 100 }), settings: { idleTimer: 30 } });
        const start = calendarDate(2026, 9, 1), end = calendarDate(2026, 9, 7);
        const period = periodData(snapshot, start, end);
        expect(period.days).toHaveLength(7); expect(period.days[1].total).toBe(0);
        expect(period.total).toBe(10800); expect(period.average).toBe(10800 / 7);
        expect(period.sites).toEqual([{ domain: 'b', seconds: 7200 }, { domain: 'a', seconds: 3600 }]);
        const previous = previousRange(start, end);
        expect(previous.map(dateInput)).toEqual(['2026-09-24', '2026-09-30']);
        expect(periodData(snapshot, ...previous).total).toBe(100);
    });
    it('handles exact presets, leap dates and year rollover without adding fixed milliseconds', () => {
        const end = calendarDate(2024, 2, 1);
        expect(calendarDays(shiftDay(end, -6), end).map(dateInput)).toEqual(['2024-02-24', '2024-02-25', '2024-02-26', '2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01']);
        expect(previousRange(calendarDate(2026, 0, 1), calendarDate(2026, 0, 1)).map(dateInput)).toEqual(['2025-12-31', '2025-12-31']);
        expect(calendarDays(shiftDay(end, -29), end)).toHaveLength(30);
        expect(calendarDays(end, end)).toHaveLength(1);
    });
    it('aggregates centuries using saved rows and paginates only thirty actual day bars', () => {
        const start = parseDateInput('1500-01-01')!, end = parseDateInput('2026-10-07')!;
        const snapshot = dailySnapshot({ '1500 1 1': day({ a: 60 }), '2026 10 7': day({ a: 120 }), '2026 10 8': day({ b: 900 }) });
        const first = periodData(snapshot, start, end), last = periodData(snapshot, start, end, Math.ceil(192398 / 30) - 1);
        expect(first.dayCount).toBe(192398); expect(first.days).toHaveLength(30);
        expect(first.total).toBe(180); expect(first.average).toBe(180 / 192398); expect(first.sites).toEqual([{ domain: 'a', seconds: 180 }]);
        expect(first.days.map(item => dateInput(item.date))).toEqual(calendarDays(start, shiftDay(start, 29)).map(dateInput));
        expect(last.days).toHaveLength(8); expect(dateInput(last.days[last.days.length - 1].date)).toBe('2026-10-07');
        expect(last.days[last.days.length - 1].total).toBe(120); expect(last.total).toBe(first.total); expect(last.average).toBe(first.average);
        const previous = previousRange(start, end); expect(calendarDayCount(...previous)).toBe(192398); expect(dateInput(previous[1])).toBe('1499-12-31');
    });
    it('constructs years before 100 without mapping them into the twentieth century', () => {
        expect(dateInput(calendarDate(99, 0, 1))).toBe('0099-01-01');
        expect(calendarDayCount(calendarDate(99, 0, 1), calendarDate(99, 11, 31))).toBe(365);
        const data = periodData(dailySnapshot({ '0099 1 1': day({ a: 60 }) }), calendarDate(99, 0, 1), calendarDate(99, 0, 1));
        expect(data.total).toBe(60); expect(data.days[0].total).toBe(60);
    });
    it('normalizes padded legacy date aliases into one civil day without modifying source maps', () => {
        const input = { '2026 01 07': day(JSON.parse('{"__proto__":60}')), '2026 1 7': day(JSON.parse('{"__proto__":120,"other":30}')) };
        const before = structuredClone(input), normalized = dailySnapshot(input);
        expect(Object.keys(normalized)).toEqual(['2026 1 7']); expect(normalized['2026 1 7'].netTime).toBe(210);
        expect(Object.getOwnPropertyDescriptor(normalized['2026 1 7'].websiteTime, '__proto__')?.value).toBe(180);
        const period = periodData(normalized, calendarDate(2026, 0, 7), calendarDate(2026, 0, 7));
        expect(period.total).toBe(210); expect(period.days[0].total).toBe(210); expect(period.days[0].sites.get('__proto__')).toBe(180);
        expect(input).toEqual(before);
    });
    it('rejects and flags inconsistent persisted day records without mutating saved data', () => {
        const bad = { netTime: 0, websiteTime: { a: 1 } }, invalid: string[] = [];
        const snapshot = dailySnapshot({ '2026 10 7': bad, '2026 10 6': day({ a: 10 }) }, key => invalid.push(key));
        expect(invalid).toEqual(['2026 10 7']); expect(Object.keys(snapshot)).toEqual(['2026 10 6']); expect(bad).toEqual({ netTime: 0, websiteTime: { a: 1 } });
    });
    it('filters non-date metadata and impossible dates/invalid values', () => {
        expect(Object.keys(dailySnapshot({ settings: {}, 'replacement:intent': {}, '2026 2 30': day({ a: 3 }), '2026 2 28': day({ a: 3 }), '2026 3 1': day({ a: Infinity }), '2026 3 2': { netTime: -1, websiteTime: {} } }))).toEqual(['2026 2 28']);
        expect(parseDateInput('2026-02-30')).toBeNull(); expect(parseDateInput('')).toBeNull();
        expect(dateInput(parseDateInput('2024-02-29')!)).toBe('2024-02-29');
    });
    it('ranks equal values by hostname and preserves prototype-like domain names', () => {
        const sites = JSON.parse('{"__proto__":10,"constructor":10,"a":10}');
        const data = periodData(dailySnapshot({ '2026 10 7': day(sites) }), calendarDate(2026, 9, 7), calendarDate(2026, 9, 7));
        expect(data.sites.map(site => site.domain)).toEqual(['__proto__', 'a', 'constructor']); expect(data.total).toBe(30);
        expect(domainColor('__proto__')).toMatch(/^#/); expect(domainColor('a')).toBe(domainColor('a'));
    });
    it('never emits infinite zero-baseline comparisons or wraps long total durations', () => {
        expect(changeLabel(600, 0)).toBe('New'); expect(changeLabel(0, 0)).toBe('No change');
        expect(changeLabel(300, 600)).toBe('−50%'); expect(changeLabel(600, 300)).toBe('+100%');
        expect(formatDuration(90000)).toBe('25h 0m'); expect(formatDuration(0)).toBe('0s');
    });
});

// Firefox's return-value sanitizer omits all dynamic Object.prototype names.
it('decodes reserved hostname tuples before dashboard totals and ranks', () => {
    const names = Object.getOwnPropertyNames(Object.prototype);
    const websiteTime = Object.fromEntries(names.map(name => [name, 2]));
    const raw = { netTime: names.length * 2, websiteTime: {}, websiteTimeReserved: names.map(name => [name, 2]) };
    const snapshot = dailySnapshot({'2026 10 7': raw});
    expect(snapshot['2026 10 7'].websiteTime).toEqual(websiteTime);
    const date = parseDateInput('2026-10-07')!;
    const period = periodData(snapshot, date, date);
    expect(period.total).toBe(names.length * 2);
    expect(new Map(period.sites.map(site => [site.domain, site.seconds]))).toEqual(new Map(names.map(name => [name, 2])));
    expect(snapshot['2026 10 7']).not.toHaveProperty('websiteTimeReserved');
});
