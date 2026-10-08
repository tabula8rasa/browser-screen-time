import { CalendarIdentity, SessionDecision, SessionObservation } from './sessionTypes';

export function sameDecision(a: SessionDecision, b: SessionDecision): boolean {
    return a.kind === b.kind && (a.kind === 'stop' || b.kind === 'track' && a.domain === b.domain);
}
export function sameCalendar(a: CalendarIdentity, b: CalendarIdentity): boolean {
    return a.dayKey === b.dayKey && a.timeZone === b.timeZone && a.dayStart === b.dayStart && a.dayEnd === b.dayEnd;
}
export function calendarOf(observation: CalendarIdentity): CalendarIdentity {
    return { dayKey: observation.dayKey, timeZone: observation.timeZone, dayStart: observation.dayStart, dayEnd: observation.dayEnd };
}
// This check runs at capture time. Queue execution never reconstructs local dates.
export function validCalendarTransition(previous: SessionObservation, current: SessionObservation): boolean {
    return sameCalendar(previous, current) || previous.timeZone === current.timeZone && previous.dayEnd === current.dayStart;
}
