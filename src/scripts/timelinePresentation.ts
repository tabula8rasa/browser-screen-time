import { rankSites } from './dashboardData';
export const DEFAULT_SMOOTHING_SECONDS = 800;
export function timelinePreferences(settings: unknown): { smoothingSeconds: number; hideShortIsolated: boolean } {
    const value = settings && typeof settings === 'object' ? settings as Record<string, unknown> : {};
    const raw = value.timelineSmoothingSeconds;
    const seconds = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return { smoothingSeconds: Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600 ? seconds : DEFAULT_SMOOTHING_SECONDS,
        hideShortIsolated: value.timelineHideShortIsolated === true };
}
export interface TimelineSession { id: number; domainId: number; start: number; end: number; dayKey: string; timeZone: string; dayStart: number; dayEnd: number }
export interface TimelineGroup { dayKey: string; timeZone: string; dayStart: number; dayEnd: number; status: 'available' | 'partial' | 'unavailable' }
export interface HistoryDay { status: 'available' | 'partial' | 'unavailable'; sessions: TimelineSession[]; domains: Array<{ id: number; domain: string }>; groups: TimelineGroup[]; error?: string }
export interface DisplayInterval { start: number; end: number; domain: string }
export interface TimelineRow { domain: string | null; milliseconds: number; intervals: DisplayInterval[] }
export function sameGroup(session: TimelineSession, group: TimelineGroup): boolean {
    return session.dayKey === group.dayKey && session.timeZone === group.timeZone && session.dayStart === group.dayStart && session.dayEnd === group.dayEnd;
}
// Smoothing operates only on display copies grouped by their presentation domain.
export function smoothIntervals(intervals: DisplayInterval[], threshold: number, minimumIsolatedDuration = 0): DisplayInterval[] {
    const result: DisplayInterval[] = [];
    const byDomain = new Map<string, DisplayInterval[]>();
    for (const interval of intervals) {
        const list = byDomain.get(interval.domain) ?? []; list.push({ ...interval }); byDomain.set(interval.domain, list);
    }
    for (const list of byDomain.values()) {
        list.sort((a, b) => a.start - b.start || a.end - b.end);
        const merged: Array<DisplayInterval & { sessionCount: number }> = [];
        for (const interval of list) {
            const previous = merged[merged.length - 1];
            if (threshold > 0 && previous && interval.start - previous.end <= threshold) {
                previous.end = Math.max(previous.end, interval.end);
                previous.sessionCount++;
            } else merged.push({ ...interval, sessionCount: 1 });
        }
        result.push(...merged.filter(interval => interval.sessionCount > 1 || interval.end - interval.start >= minimumIsolatedDuration)
            .map(({ sessionCount, ...interval }) => interval));
    }
    return result.sort((a, b) => a.start - b.start || a.end - b.end);
}
export function timelineRows(history: HistoryDay, group: TimelineGroup, zoom: number, smoothingSeconds = DEFAULT_SMOOTHING_SECONDS, hideShortIsolated = false): TimelineRow[] {
    const domains = new Map(history.domains.map(item => [item.id, item.domain]));
    const intervals = history.sessions.filter(session => sameGroup(session, group) && session.end > session.start && domains.has(session.domainId))
        .map(session => ({ domain: domains.get(session.domainId)!, start: Math.max(session.start, group.dayStart), end: Math.min(session.end, group.dayEnd) }))
        .filter(interval => interval.end > interval.start);
    const totals = new Map<string, number>();
    for (const interval of intervals) totals.set(interval.domain, (totals.get(interval.domain) ?? 0) + interval.end - interval.start);
    const top = rankSites(totals).slice(0, 4).map(site => site.domain);
    const threshold = zoom >= 4 ? 0 : smoothingSeconds * 1000 / zoom;
    const minimumIsolatedDuration = hideShortIsolated && zoom === 1 ? 5 * 60000 : 0;
    const rows = top.map(domain => ({ domain, milliseconds: totals.get(domain)!, intervals: smoothIntervals(intervals.filter(item => item.domain === domain), threshold, minimumIsolatedDuration) }));
    while (rows.length < 4) rows.push({ domain: null, milliseconds: 0, intervals: [] });
    const other = intervals.filter(item => !top.includes(item.domain));
    // Decide isolation per real website before combining domains into the Other lane.
    const visibleOther = smoothIntervals(other, threshold, minimumIsolatedDuration);
    const otherDisplay = zoom >= 4 ? visibleOther : smoothIntervals(visibleOther.map(interval => ({ ...interval, domain: 'Other' })), threshold);
    rows.push({ domain: null, milliseconds: other.reduce((sum, item) => sum + item.end - item.start, 0), intervals: otherDisplay });
    return rows;
}
export function axisLabel(epoch: number, group: TimelineGroup, seconds = false): string {
    if (epoch === group.dayEnd) return '24:00';
    const longDay = group.dayEnd - group.dayStart !== 86400000;
    return new Intl.DateTimeFormat('en-GB', { timeZone: group.timeZone, hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' as const } : {}), ...(longDay ? { timeZoneName: 'shortOffset' as const } : {}) }).format(epoch);
}
