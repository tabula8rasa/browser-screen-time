import { describe, expect, it } from 'vitest';
import { captureObservation, continuityGap, localCalendar } from '../src/scripts/sessionClock';
import { sameDecision } from '../src/scripts/sessionLifecycle';
const t = Date.UTC(2026, 9, 7);
const identity = { dayKey: '2026-10-07', timeZone: 'UTC', dayStart: t, dayEnd: t + 86400000 };
const clock = (wall = t, mono = 0) => ({ wall: () => wall, mono: () => mono, zone: () => 'UTC', calendar: () => identity });
describe('synchronous observations and conservative continuity', () => {
    it('copies immutable decision/calendar before later state changes', () => {
        const decision = { kind: 'track' as const, domain: 'a.test' }; const observation = captureObservation(clock(), decision, 1, 2);
        decision.domain = 'b.test'; expect(observation.decision).toEqual({ kind: 'track', domain: 'a.test' }); expect(Object.isFrozen(observation)).toBe(true);
    });
    it.each([[5000, 5000, undefined], [5001, 5001, 'observation-gap'], [1000, 3000, undefined], [1000, 3001, 'clock-change'], [-1, 1, 'clock-change'], [1, -1, 'clock-change'], [3600000, 3600000, 'observation-gap'], [3600000, 1, 'clock-change']])('wall %s mono %s yields %s', (wall, mono, reason) => {
        expect(continuityGap(captureObservation(clock(t + 10000), { kind: 'stop' }, 1, 1), captureObservation(clock(t + 10000 + Number(wall), Number(mono)), { kind: 'stop' }, 2, 1))).toBe(reason);
    });
    it('boundedly rejects a mixed timezone sample, and zone identity alone splits continuity', () => {
        let reads = 0; const mixed = { ...clock(), zone: () => reads++ % 2 ? 'Asia/Tbilisi' : 'UTC' };
        expect(() => captureObservation(mixed, { kind: 'stop' }, 1, 1)).toThrow('Timezone changed'); expect(reads).toBe(4);
        const first = captureObservation(clock(), { kind: 'stop' }, 1, 1);
        expect(continuityGap(first, { ...first, sequence: 2, timeZone: 'Asia/Tbilisi' })).toBe('timezone-change');
    });
    it('uses full calendar dates across month/year/leap boundaries', () => {
        for (const date of ['2024-02-29T12:00Z', '2026-12-31T12:00Z', '2027-01-01T12:00Z']) {
            const result = localCalendar(Date.parse(date)); expect(result.dayStart).toBeLessThanOrEqual(Date.parse(date)); expect(result.dayEnd).toBeGreaterThan(Date.parse(date));
        }
        expect(sameDecision({ kind: 'track', domain: 'a.test' }, { kind: 'track', domain: 'a.test' })).toBe(true);
        expect(sameDecision({ kind: 'track', domain: 'a.test' }, { kind: 'stop' })).toBe(false);
    });
});
