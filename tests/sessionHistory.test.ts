import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { setImmediate as realImmediate } from 'node:timers';
import { SessionHistory } from '../src/scripts/sessionHistory';
import { SessionStorage } from '../src/scripts/sessionStorage';
import { deferred, flush } from './helpers/browserMock';
import type { CalendarIdentity, SessionDecision } from '../src/scripts/sessionTypes';
const start = Date.UTC(2026, 9, 7);
let wall: number, mono: number, calendar: CalendarIdentity, storage: SessionStorage, history: SessionHistory;
function observe(offset: number, domain?: string) {
    const delta = start + offset - wall; wall = start + offset; mono += Math.max(delta, 0);
    history.observe(domain ? { kind: 'track', domain } : { kind: 'stop' });
}
beforeEach(() => {
    vi.useFakeTimers(); vi.stubGlobal('setImmediate', realImmediate); globalThis.IDBKeyRange = IDBKeyRange;
    wall = start; mono = 0; calendar = { dayKey: '2026-10-07', timeZone: 'UTC', dayStart: start, dayEnd: start + 86400000 };
    storage = new SessionStorage(new IDBFactory());
    history = new SessionHistory(storage, { wall: () => wall, mono: () => mono, zone: () => calendar.timeZone, calendar: () => ({ ...calendar }) });
});
afterEach(() => { history.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('single authoritative observer FIFO, finite checkpoints and failure fences', () => {
    it('attaches from latest cached decision without backfilling pre-readiness history', async () => {
        const gate = deferred<void>(), open = storage.open.bind(storage); vi.spyOn(storage, 'open').mockImplementation(async () => { await gate.promise; await open(); });
        history.observe({ kind: 'track', domain: 'a.test' }); history.start(); observe(1000, 'b.test');
        gate.resolve(); await history.settled(); await flush(); observe(2000); await history.settled();
        const snapshot = await storage.snapshot(); expect(snapshot.sessions).toHaveLength(1); expect(snapshot.sessions[0].start).toBe(start + 1000); expect(snapshot.domains[0].domain).toBe('b.test');
    });
    it('persists A→STOP→A rather than coalescing intermediate transitions behind delayed I/O', async () => {
        history.observe({ kind: 'track', domain: 'a.test' }); history.start(); await history.settled(); await flush();
        const gate = deferred<void>(), apply = storage.apply.bind(storage); vi.spyOn(storage, 'apply').mockImplementationOnce(async (...args) => { await gate.promise; return apply(...args); });
        observe(1000); await flush(); observe(2000, 'a.test'); observe(3000);
        gate.resolve(); await history.settled();
        expect((await storage.snapshot()).sessions.map(row => [row.start - start, row.end - start])).toEqual([[0, 1000], [2000, 3000]]);
    });
    it('maintenance observes memory every second but writes only 30s finite checkpoints', async () => {
        const apply = vi.spyOn(storage, 'apply'); history.observe({ kind: 'track', domain: 'a.test' }); history.start(); await history.settled(); await flush();
        for (let second = 1; second <= 30; second++) { wall = start + second * 1000; mono = second * 1000; await vi.advanceTimersByTimeAsync(1000); }
        await history.settled(); expect(apply).toHaveBeenCalledTimes(2); expect((await storage.snapshot()).sessions[0].end).toBe(start + 30000);
        await history.exportSnapshot(); expect(apply).toHaveBeenCalledTimes(3);
    });
    it('a delayed STOP after hours asleep cannot extend the last reliable in-memory observation', async () => {
        history.observe({ kind: 'track', domain: 'a.test' }); history.start(); await history.settled(); await flush(); observe(1000, 'a.test'); observe(2000, 'a.test');
        observe(3600000); await history.settled();
        const snapshot = await storage.snapshot(); expect(snapshot.sessions[0].end).toBe(start + 2000); expect(snapshot.coverage[0].start).toBe(start + 2000);
    });
    it('keeps immutable old-zone queued calendars across a later timezone change', async () => {
        history.start(); await history.settled(); await flush(); const gate = deferred<void>(), apply = storage.apply.bind(storage);
        vi.spyOn(storage, 'apply').mockImplementationOnce(async (...args) => { await gate.promise; return apply(...args); });
        observe(1000, 'a.test'); await flush();
        calendar = { dayKey: '2026-10-07', timeZone: 'Asia/Tbilisi', dayStart: start - 4 * 3600000, dayEnd: start + 20 * 3600000 };
        observe(2000, 'a.test'); observe(3000); gate.resolve(); await history.settled();
        const sessions = (await storage.snapshot()).sessions;
        expect(sessions.map(row => row.timeZone)).toEqual(['Asia/Tbilisi']); // Old-zone segment lasted zero observed ms and is omitted.
        expect(sessions[0].dayStart).toBe(start - 4 * 3600000);
        const windows = (await storage.snapshot()).observedWindows; expect(windows.some(row => row.timeZone === 'UTC' && row.dayStart === start)).toBe(true);
    });
    it('quarantines a timed-out unknown write until actual settlement, then recovers without backfill', async () => {
        history.start(); await history.settled(); await flush(); const gate = deferred<{ floor: number; suppressed: boolean }>();
        vi.spyOn(storage, 'apply').mockImplementationOnce(() => gate.promise); vi.spyOn(storage, 'abort').mockImplementation(() => {});
        const recover = vi.spyOn(storage, 'recover'); observe(1000, 'a.test'); await flush();
        await vi.advanceTimersByTimeAsync(11000); expect((await history.query(calendar.dayKey)).status).toBe('unavailable'); expect(recover).not.toHaveBeenCalled();
        gate.resolve({ floor: start + 1000, suppressed: false }); await flush(); wall = start + 12000; mono = 12000; await vi.advanceTimersByTimeAsync(1000); await flush();
        expect(recover).toHaveBeenCalledTimes(1); observe(13000); await history.settled();
        const sessions = (await storage.snapshot()).sessions; expect(sessions[0].start).toBe(start + 12000);
    });
    it('overload unwinds queue counts so fresh recovery after 60s can record again', async () => {
        history.start(); await history.settled(); await flush(); const gate = deferred<{floor: number; suppressed: boolean}>();
        vi.spyOn(storage, 'apply').mockImplementationOnce(() => gate.promise); vi.spyOn(storage, 'abort').mockImplementation(() => {});
        observe(1, 'a.test'); await flush();
        for (let i = 2; i <= 1003; i++) observe(i, i % 2 ? 'a.test' : 'b.test');
        gate.resolve({ floor: start, suppressed: false }); await history.settled();
        wall = start + 61000; mono = 61000; await vi.advanceTimersByTimeAsync(1000); await flush(); observe(62000); await history.settled();
        expect((await storage.snapshot()).sessions[0].start).toBe(start + 61000);
    });
    it('replacement preflight times out without launching a competing writer; late outcome cannot reopen old generation', async () => {
        history.start(); await history.settled(); await flush(); const gate = deferred<{floor: number; suppressed: boolean}>();
        vi.spyOn(storage, 'apply').mockImplementationOnce(() => gate.promise); vi.spyOn(storage, 'abort').mockImplementation(() => {});
        const recover = vi.spyOn(storage, 'recover'); observe(1000, 'a.test'); await flush(); history.fenceReplacement();
        const rejection = history.preflight().catch(error => error.message); await vi.advanceTimersByTimeAsync(10000);
        expect(await rejection).toMatch(/10 seconds/); history.releaseReplacement(); expect(recover).not.toHaveBeenCalled();
        gate.resolve({ floor: start, suppressed: false }); await flush(); expect(recover).not.toHaveBeenCalled();
        wall = start + 12000; mono = 12000; await vi.advanceTimersByTimeAsync(1000); await flush(); expect(recover).toHaveBeenCalledTimes(1);
    });
    it('stop during delayed startup is terminal after late open settlement', async () => {
        const gate = deferred<void>(), open = storage.open.bind(storage); const spy = vi.spyOn(storage, 'open').mockImplementation(async () => { await gate.promise; await open(); });
        const recover = vi.spyOn(storage, 'recover'); history.start(); history.stop(); gate.resolve(); await flush(); await vi.advanceTimersByTimeAsync(120000); await flush();
        expect(spy).toHaveBeenCalledTimes(1); expect(recover).not.toHaveBeenCalled(); expect((await history.query(calendar.dayKey)).status).toBe('unavailable');
    });
});
