import { CalendarIdentity, SessionDecision, SessionObservation, GapReason } from './sessionTypes';

export interface SessionClockAdapter { wall(): number; mono(): number; zone(): string; calendar(t: number): CalendarIdentity }
export function localCalendar(t: number): CalendarIdentity {
    const date = new Date(t);
    const year = date.getFullYear(), month = date.getMonth(), day = date.getDate();
    const start = new Date(t), end = new Date(t);
    start.setHours(0, 0, 0, 0); end.setDate(day + 1); end.setHours(0, 0, 0, 0);
    return { dayKey: `${year.toString().padStart(4, '0')}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, dayStart: +start, dayEnd: +end };
}
export const systemSessionClock: SessionClockAdapter = {
    wall: () => Date.now(), mono: () => performance.now(),
    zone: () => Intl.DateTimeFormat().resolvedOptions().timeZone, calendar: localCalendar
};
export function validCalendar(value: CalendarIdentity, t?: number): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value.dayKey) && typeof value.timeZone === 'string' && !!value.timeZone &&
        Number.isSafeInteger(value.dayStart) && Number.isSafeInteger(value.dayEnd) && value.dayStart < value.dayEnd &&
        (t === undefined || value.dayStart <= t && t < value.dayEnd);
}
export function captureObservation(clock: SessionClockAdapter, decision: SessionDecision, sequence: number, generation: number): SessionObservation {
    for (let attempt = 0; attempt < 2; attempt++) {
        const wallTimestamp = clock.wall(), monotonicTimestamp = clock.mono(), zone = clock.zone();
        const calendar = clock.calendar(wallTimestamp);
        if (zone !== clock.zone() || calendar.timeZone !== zone) continue;
        if (!Number.isSafeInteger(wallTimestamp) || !Number.isFinite(monotonicTimestamp) || !validCalendar(calendar, wallTimestamp)) {
            throw new Error('Invalid session clock/calendar sample');
        }
        return Object.freeze({ ...calendar, wallTimestamp, monotonicTimestamp, sequence, historyGeneration: generation,
            decision: Object.freeze({ ...decision }) });
    }
    throw new Error('Timezone changed during session capture');
}
export function continuityGap(previous: SessionObservation, current: SessionObservation): GapReason | undefined {
    if (previous.timeZone !== current.timeZone) return 'timezone-change';
    const wall = current.wallTimestamp - previous.wallTimestamp, mono = current.monotonicTimestamp - previous.monotonicTimestamp;
    if (wall < 0 || mono < 0 || Math.abs(wall - mono) > 2000) return 'clock-change';
    if (wall > 5000 || mono > 5000) return 'observation-gap';
}
