import { CounterDailyData } from './counter';
import { decodeDailyData } from './dailyDataCodec';
import { consistentDailyTotal } from './dailyTotals';

export interface DashboardDay { key: string; date: Date; total: number; sites: Map<string, number> }
export interface RankedSite { domain: string; seconds: number }
export interface DashboardPeriod { days: DashboardDay[]; dayCount: number; total: number; sites: RankedSite[]; average: number }
export type DailySnapshot = Record<string, CounterDailyData>;

export function dateInput(date: Date): string {
    return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
export function parseDateInput(value: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const [, y, m, d] = match.map(Number);
    const date = calendarDate(y, m - 1, d);
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}
// Aggregate dates are civil-date UTC surrogates, never physical session timestamps.
export function calendarDate(year: number, month: number, day: number): Date {
    const result = new Date(0); result.setUTCFullYear(year, month, day); result.setUTCHours(0, 0, 0, 0); return result;
}
// Capture the actual device-local date once, then enter civil calendar algebra.
export function localToday(now = new Date()): Date { return calendarDate(now.getFullYear(), now.getMonth(), now.getDate()); }
// Count civil dates, independent of 23/25-hour days and Date's 1900 offset for years 0–99.
function civilOrdinal(date: Date): number {
    const result = new Date(0); result.setUTCFullYear(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()); result.setUTCHours(0, 0, 0, 0);
    return Math.floor(result.getTime() / 86400000);
}
export function calendarDayCount(start: Date, end: Date): number { return Math.max(0, civilOrdinal(end) - civilOrdinal(start) + 1); }
export function shiftDay(date: Date, offset: number): Date {
    const result = new Date(date); result.setUTCDate(result.getUTCDate() + offset); result.setUTCHours(0, 0, 0, 0); return result;
}
export function legacyKey(date: Date): string { return `${String(date.getUTCFullYear()).padStart(4, '0')} ${date.getUTCMonth() + 1} ${date.getUTCDate()}`; }
export function dailySnapshot(input: Record<string, unknown>, onInvalid?: (key: string) => void): DailySnapshot {
    const result: DailySnapshot = {};
    for (const [key, raw] of Object.entries(input)) {
        const match = /^(\d{4}) (\d{1,2}) (\d{1,2})$/.exec(key);
        if (!match) continue;
        if (!parseDateInput(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`)) { onInvalid?.(key); continue; }
        let day: CounterDailyData;
        try { day = decodeDailyData(raw); } catch { onInvalid?.(key); continue; }
        if (!day || !Number.isFinite(day.netTime) || day.netTime < 0 || !day.websiteTime || typeof day.websiteTime !== 'object' || Array.isArray(day.websiteTime)) { onInvalid?.(key); continue; }
        const values = Object.values(day.websiteTime);
        if (!values.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) || !consistentDailyTotal(day.netTime, values)) { onInvalid?.(key); continue; }
        const canonical = legacyKey(parseDateInput(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`)!);
        const existing = result[canonical];
        const sites = new Map(Object.entries(existing?.websiteTime ?? {}));
        for (const [domain, seconds] of Object.entries(day.websiteTime)) sites.set(domain, (sites.get(domain) ?? 0) + seconds);
        result[canonical] = { ...day, netTime: (existing?.netTime ?? 0) + day.netTime, websiteTime: Object.fromEntries(sites) };
    }
    return result;
}
export function calendarDays(start: Date, end: Date): Date[] {
    const result: Date[] = [];
    for (let date = shiftDay(start, 0); date <= end; date = shiftDay(date, 1)) result.push(date);
    return result;
}
export function rankSites(map: Map<string, number>): RankedSite[] {
    return [...map].filter(([, n]) => n > 0).map(([domain, seconds]) => ({ domain, seconds }))
        .sort((a, b) => b.seconds - a.seconds || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
}
export const CHART_PAGE_DAYS = 30;
export function periodData(snapshot: DailySnapshot, start: Date, end: Date, page = 0): DashboardPeriod {
    const combined = new Map<string, number>();
    const first = civilOrdinal(start), last = civilOrdinal(end), dayCount = calendarDayCount(start, end);
    let total = 0;
    // Work scales with actual saved records, not centuries of empty calendar dates.
    for (const [key, raw] of Object.entries(snapshot)) {
        const [y, m, d] = key.split(' ').map(Number);
        const ordinal = civilOrdinal(calendarDate(y, m - 1, d));
        if (ordinal < first || ordinal > last) continue;
        total += raw.netTime;
        for (const [domain, seconds] of Object.entries(raw.websiteTime)) combined.set(domain, (combined.get(domain) ?? 0) + seconds);
    }
    const pageIndex = Math.min(Math.max(0, page), Math.max(0, Math.ceil(dayCount / CHART_PAGE_DAYS) - 1));
    const offset = pageIndex * CHART_PAGE_DAYS;
    const days = Array.from({ length: Math.min(CHART_PAGE_DAYS, Math.max(0, dayCount - offset)) }, (_, index) => {
        const date = shiftDay(start, offset + index), key = legacyKey(date), raw = snapshot[key];
        return { key, date, total: raw?.netTime ?? 0, sites: new Map<string, number>(Object.entries(raw?.websiteTime ?? {})) };
    });
    return { days, dayCount, total, sites: rankSites(combined), average: dayCount ? total / dayCount : 0 };
}
export function previousRange(start: Date, end: Date): [Date, Date] {
    return [shiftDay(start, -calendarDayCount(start, end)), shiftDay(start, -1)];
}
export function formatDuration(seconds: number): string {
    const rounded = Math.floor(Math.abs(seconds));
    const hours = Math.floor(rounded / 3600), minutes = Math.floor(rounded % 3600 / 60);
    return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m` : `${rounded}s`;
}
export function changeLabel(current: number, previous: number): string {
    if (!previous) return current ? 'New' : 'No change';
    return `${current >= previous ? '+' : '−'}${Math.round(Math.abs(current - previous) / previous * 100)}%`;
}
export function domainColor(domain: string): string {
    const palette = ['#ff5475', '#32d8aa', '#347cff', '#ffd34e', '#b36aff', '#5ec8e8', '#ff995c', '#a3b3d3'];
    let hash = 0; for (const char of domain) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return palette[(hash >>> 0) % palette.length];
}
export function domainInitial(domain: string): string { return domain.replace(/^www\./, '').slice(0, 1).toUpperCase() || '•'; }
