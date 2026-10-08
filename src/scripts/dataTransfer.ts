import type { CounterData } from './counter';
import { validCalendar } from './sessionClock';
import { CalendarIdentity, HistorySnapshot, SessionExportV1 } from './sessionTypes';
import Utils from './utils';
import { decodeDailyMap } from './dailyDataCodec';

export function emptyHistory(): HistorySnapshot {
    return { schemaVersion: 1, status: 'unavailable', recordingSince: null, domains: [], sessions: [], coverage: [], observedWindows: [], invalidDays: [] };
}
export interface ParsedTransfer { daily: CounterData; history?: HistorySnapshot }
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function validDay(dayKey: string): boolean { return typeof dayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dayKey) && Utils.isDailyKey(dayKey.split('-').map(Number).join(' ')); }
function validateCalendar(row: CalendarIdentity, identities: Set<string>, formatters: Map<string, Intl.DateTimeFormat>): void {
    assert(row && validCalendar(row) && validDay(row.dayKey), 'Invalid imported calendar identity');
    const identity = JSON.stringify([row.dayKey, row.timeZone, row.dayStart, row.dayEnd]);
    if (identities.has(identity)) return;
    let formatter = formatters.get(row.timeZone);
    if (!formatter) {
        try { formatter = new Intl.DateTimeFormat('en-US', { timeZone: row.timeZone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' }); }
        catch { throw new Error('Invalid imported timezone'); }
        formatters.set(row.timeZone, formatter);
    }
    const dateKey = (t: number) => {
        const parts = formatter.formatToParts(t);
        const part = (type: string) => parts.find(value => value.type === type)?.value;
        return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
    };
    assert(dateKey(row.dayStart) === row.dayKey && dateKey(row.dayEnd - 1) === row.dayKey &&
        dateKey(row.dayStart - 1) !== row.dayKey && dateKey(row.dayEnd) !== row.dayKey, 'Imported calendar labels/bounds do not describe a local day');
    identities.add(identity);
}
function validateInterval(row: { start: number; end: number }, horizon: number, positive: boolean): void {
    assert(row && integer(row.start) && integer(row.end) && row.start >= 0 && row.start <= row.end && (!positive || row.start < row.end) && row.end <= horizon, 'Invalid imported history interval/horizon');
}
export function parseTransfer(data: unknown, mode: 'overwrite' | 'merge', now = Date.now()): ParsedTransfer {
    const envelope = data as SessionExportV1;
    if (!envelope || typeof envelope !== 'object' || !('format' in envelope)) {
        const daily = decodeDailyMap(data as CounterData); Utils.isValidCounterData(daily); return { daily: structuredClone(daily) };
    }
    assert(envelope.format === 'browser-screen-time' && envelope.formatVersion === 1, 'Unsupported backup format');
    assert(mode !== 'merge', 'Detailed backups cannot be merged; use overwrite');
    assert(integer(envelope.exportedAt) && envelope.exportedAt >= 0 && envelope.exportedAt <= now + 2000, 'Invalid backup timestamp');
    const daily = decodeDailyMap(envelope.dailyAggregates);
    Utils.isValidCounterData(daily);
    const history = envelope.history;
    assert(history && history.schemaVersion === 1 && ['available', 'partial', 'unavailable'].includes(history.status), 'Invalid history schema/status');
    const horizon = Math.min(envelope.exportedAt, now) + 2000;
    const identities = new Set<string>(), formatters = new Map<string, Intl.DateTimeFormat>();
    assert((history.recordingSince === null && history.status !== 'available') || integer(history.recordingSince) && history.recordingSince >= 0 && history.recordingSince <= horizon, 'Invalid history origin');
    for (const key of ['domains', 'sessions', 'coverage', 'observedWindows', 'invalidDays']) assert(Array.isArray(history[key]), `Invalid history ${key}`);
    const ids = new Set<number>(), names = new Set<string>();
    for (const domain of history.domains) {
        assert(domain && integer(domain.id) && domain.id > 0 && !ids.has(domain.id) && typeof domain.domain === 'string' && !!domain.domain && !names.has(domain.domain), 'Invalid/duplicate imported domain');
        let hostname: string;
        try { hostname = new URL(`https://${domain.domain}/`).hostname; } catch { throw new Error('Invalid imported hostname'); }
        assert(hostname === domain.domain, 'Imported hostname must be normalized'); ids.add(domain.id); names.add(domain.domain);
    }
    const sessionIds = new Set<number>();
    const ordered = [...history.sessions].sort((a, b) => a.start - b.start || a.id - b.id);
    let end = 0;
    for (const row of ordered) {
        assert(integer(row.id) && row.id > 0 && !sessionIds.has(row.id) && ids.has(row.domainId), 'Invalid session/domain reference');
        validateInterval(row, horizon, true); validateCalendar(row, identities, formatters);
        assert(row.dayStart <= row.start && row.end <= row.dayEnd && row.start >= end, 'Overlapping/out-of-day imported sessions');
        sessionIds.add(row.id); end = row.end;
    }
    const gapIds = new Set<number>();
    for (const row of history.coverage) {
        validateInterval(row, horizon, true);
        assert(integer(row.id) && row.id >= 0 && !gapIds.has(row.id) && ['storage-unavailable', 'observation-gap', 'clock-change', 'timezone-change', 'restart', 'legacy-merge'].includes(row.reason), 'Invalid imported coverage'); gapIds.add(row.id);
    }
    for (const row of history.observedWindows) {
        validateInterval(row, horizon, false); validateCalendar(row, identities, formatters);
        assert(row.dayStart <= row.start && row.end <= row.dayEnd, 'Out-of-day imported observation coverage');
    }
    for (const row of history.invalidDays) assert(row && validDay(row.dayKey) && ['legacy-merge', 'legacy-import'].includes(row.reason), 'Invalid imported day marker');
    // Reconstruct the accepted shape; ownership/intents/extra mutable state are
    // never imported even if a file contains unrelated properties.
    const calendar = (row: CalendarIdentity) => ({ dayKey: row.dayKey, timeZone: row.timeZone, dayStart: row.dayStart, dayEnd: row.dayEnd });
    return { daily: structuredClone(daily), history: {
        schemaVersion: 1, status: history.status, recordingSince: history.recordingSince,
        domains: history.domains.map(({ id, domain }) => ({ id, domain })),
        sessions: ordered.map(row => ({ ...calendar(row), id: row.id, domainId: row.domainId, start: row.start, end: row.end })),
        coverage: history.coverage.map(({ id, start, end, reason }) => ({ id, start, end, reason })),
        observedWindows: history.observedWindows.map(row => ({ ...calendar(row), start: row.start, end: row.end })),
        invalidDays: history.invalidDays.map(({ dayKey, reason }) => ({ dayKey, reason }))
    } };
}
export function captureDayKey(legacy: string): string { return legacy.split(' ').map((part, i) => part.padStart(i ? 2 : 4, '0')).join('-'); }
