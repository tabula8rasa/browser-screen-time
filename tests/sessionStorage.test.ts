import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('webextension-polyfill', () => ({ default: {} }));
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { SessionStorage, idbRequest } from '../src/scripts/sessionStorage';
import { parseTransfer } from '../src/scripts/dataTransfer';
import type { CalendarIdentity, SessionObservation } from '../src/scripts/sessionTypes';

const midnight = Date.UTC(2026, 9, 7), end = midnight + 86400000;
const calendar: CalendarIdentity = { dayKey: '2026-10-07', timeZone: 'UTC', dayStart: midnight, dayEnd: end };
let storage: SessionStorage;
let sequence = 0;
function observation(t: number, domain?: string, identity = calendar, generation = 1): SessionObservation {
    return { ...identity, wallTimestamp: t, monotonicTimestamp: t - midnight, sequence: ++sequence, historyGeneration: generation,
        decision: domain ? { kind: 'track', domain } : { kind: 'stop' } };
}
async function apply(t: number, domain?: string, identity = calendar) { return storage.apply('one', 1, { observation: observation(t, domain, identity) }); }
beforeEach(async () => { globalThis.IDBKeyRange = IDBKeyRange; sequence = 0; storage = new SessionStorage(new IDBFactory()); await storage.open(); await storage.recover('one', 1, midnight); });
afterEach(() => storage.close());

describe('native-shaped atomic session storage', () => {
    it('records direct transitions, STOP gaps, same-domain checkpoints and special hostname dictionary once', async () => {
        await apply(midnight, '__proto__'); await apply(midnight + 1000, '__proto__'); await apply(midnight + 2000, 'constructor');
        await apply(midnight + 3000); await apply(midnight + 5000, 'constructor'); await apply(midnight + 6000);
        const snapshot = await storage.snapshot();
        expect(snapshot.sessions.map(row => [row.start - midnight, row.end - midnight])).toEqual([[0, 2000], [2000, 3000], [5000, 6000]]);
        expect(snapshot.domains.map(row => row.domain)).toEqual(['__proto__', 'constructor']);
        expect((await storage.query('2026-10-07')).status).toBe('partial');
    });
    it('drops zero finalized rows and recovers only a committed finite checkpoint', async () => {
        await apply(midnight, 'a.test'); await apply(midnight); expect((await storage.snapshot()).sessions).toEqual([]);
        await apply(midnight + 1000, 'a.test'); await apply(midnight + 30000, 'a.test');
        await storage.recover('two', 2, midnight + 8 * 3600000);
        expect((await storage.snapshot()).sessions[0].end).toBe(midnight + 30000);
        await expect(storage.apply('one', 1, { observation: observation(midnight + 40000, 'a.test') })).rejects.toThrow('Stale');
        expect((await storage.snapshot()).coverage[0].end).toBe(midnight + 8 * 3600000);
    });
    it('splits tracked and STOP-only observed coverage at the exact immutable midnight', async () => {
        const tomorrow = { ...calendar, dayKey: '2026-10-08', dayStart: end, dayEnd: end + 86400000 };
        await apply(end - 1000, 'a.test'); await apply(end + 1000, 'a.test', tomorrow); await apply(end + 2000, undefined, tomorrow);
        const snapshot = await storage.snapshot();
        expect(snapshot.sessions.map(row => [row.dayKey, row.start, row.end])).toEqual([['2026-10-07', end - 1000, end], ['2026-10-08', end, end + 2000]]);
        expect(snapshot.observedWindows.map(row => [row.dayKey, row.end])).toEqual([['2026-10-07', end], ['2026-10-08', end + 2000]]);
        await apply(end + 3000, undefined, tomorrow);
        expect((await storage.query('2026-10-08')).groups).toHaveLength(1);
    });
    it('queries one predecessor without counting touching endpoints or provisional zero rows', async () => {
        await apply(midnight, 'a.test'); await apply(midnight + 10000, 'b.test'); await apply(midnight + 20000);
        await apply(midnight + 30000, 'a.test');
        expect((await storage.query(undefined, [midnight + 5000, midnight + 15000])).sessions).toHaveLength(2);
        expect((await storage.query(undefined, [midnight + 10000, midnight + 20000])).sessions.map(row => row.start)).toEqual([midnight + 10000]);
        expect((await storage.query(undefined, [midnight + 20000, midnight + 31000])).sessions).toEqual([]);
        const id = (await storage.snapshot()).domains[0].id;
        expect((await storage.query(undefined, [midnight + 5000, midnight + 15000], id)).sessions).toHaveLength(1);
    });
    it('truncates discontinuities to last reliable memory sample and suppresses backwards coverage', async () => {
        await apply(midnight, 'a.test'); const previous = observation(midnight + 3000, 'a.test');
        await storage.apply('one', 1, { observation: observation(midnight + 3600000, 'a.test'), previousReliable: previous, gap: 'observation-gap' });
        expect((await storage.snapshot()).sessions[0].end).toBe(midnight + 3000);
        const backwards = await storage.apply('one', 1, { observation: observation(midnight + 5000), previousReliable: observation(midnight + 3600000), gap: 'clock-change' });
        expect(backwards.suppressed).toBe(true); expect(backwards.floor).toBe(midnight + 3600000);
        expect((await storage.snapshot()).sessions).toHaveLength(1);
    });
    it('proves a complete STOP-only day without inventing any sessions', async () => {
        await apply(midnight); const tomorrow = { ...calendar, dayKey: '2026-10-08', dayStart: end, dayEnd: end + 86400000 };
        await apply(end, undefined, tomorrow);
        const day = await storage.query('2026-10-07'); expect(day.status).toBe('available'); expect(day.sessions).toEqual([]);
        const backup = { format: 'browser-screen-time', formatVersion: 1, exportedAt: end, dailyAggregates: {}, history: await storage.snapshot() };
        expect(parseTransfer(backup, 'overwrite', end).history.observedWindows[0]).toEqual({ ...calendar, start: midnight, end });
    });
    it('interrupted merge retains actual unaffected history and its ordering floor', async () => {
        await apply(midnight, 'a.test'); await apply(midnight + 10000); await storage.prepare({ key: 'replacement', operationId: 'merge', kind: 'legacy-merge', affectedDayKeys: ['2026-10-06'], beganAt: midnight + 10000, recovery: 'discard-affected-detail' });
        await storage.recover('two', 2, midnight + 1000);
        const result = await storage.apply('two', 2, { observation: observation(midnight + 2000, 'b.test', calendar, 2) });
        expect(result.suppressed).toBe(true); expect(result.floor).toBe(midnight + 10000);
        expect((await storage.snapshot()).sessions).toHaveLength(1);
    });
    it('exports unique gap identities across runs and imports without ownership or zero rows', async () => {
        await apply(midnight, 'a.test'); await apply(midnight + 1000);
        await storage.recover('two', 2, midnight + 5000);
        await storage.apply('two', 2, { observation: observation(midnight + 5000, 'a.test', calendar, 2) });
        await storage.recover('three', 3, midnight + 10000);
        const original = await storage.snapshot();
        const parsed = parseTransfer({ format: 'browser-screen-time', formatVersion: 1, exportedAt: midnight + 10000, dailyAggregates: {}, history: original }, 'overwrite', midnight + 10000);
        await storage.prepare({ key: 'replacement', operationId: 'overwrite', kind: 'overwrite', affectedDayKeys: [], beganAt: midnight + 10000, recovery: 'discard-affected-detail' });
        await storage.finalize('four', 4, midnight + 10000, parsed.history);
        expect((await storage.snapshot()).sessions.map(({ id, domainId, ...row }) => row)).toEqual(original.sessions.map(({ id, domainId, ...row }) => row));
        expect(new Set(original.coverage.map(row => row.id)).size).toBe(original.coverage.length);
    });
    it('aborts a transaction whose successful requests precede a failure and clears active ownership', async () => {
        await expect(storage.transaction('readwrite', async tx => { await idbRequest(tx.objectStore('domains').add({ domain: 'a.test' })); throw new Error('late failure'); })).rejects.toThrow('late failure');
        expect((await storage.snapshot()).domains).toEqual([]); expect(storage.activeTransaction).toBeUndefined();
    });
    it('rejects corrupt open ownership without silently recovering it', async () => {
        await storage.transaction('readwrite', async tx => { await idbRequest(tx.objectStore('metadata').put({ key: 'open', sessionId: 99, ownerRunId: 'missing', generation: 1 })); });
        await expect(storage.recover('two', 2, midnight)).rejects.toThrow('Corrupt open');
    });
});
