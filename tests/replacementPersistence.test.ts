import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMock, deferred, flush, settings } from './helpers/browserMock';
import type { CounterDailyData } from '../src/scripts/counter';

let mock: ReturnType<typeof createBrowserMock>;
let storage: typeof import('../src/scripts/counterStorage').default;
const today = '2026 10 7';
function day(n: number): CounterDailyData {
    return { netTime: n, websiteTime: { 'github.com': n },
        colors: ['#227C9D', '#17C3B2', '#FFCB77', '#FE6D73'], otherColor: '#CFCFCF' };
}
async function ticks(n: number) { await vi.advanceTimersByTimeAsync(n * 1000); await flush(); }
beforeEach(async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 7, 12));
    mock = createBrowserMock(); mock.data.settings = { ...settings };
    mock.browser.runtime.sendMessage.mockImplementation(async msg =>
        mock.browser.runtime.onMessage.emit(msg).find(result => result !== undefined));
    vi.doMock('webextension-polyfill', () => ({ default: mock.browser }));
    storage = (await import('../src/scripts/counterStorage')).default;
    await import('../src/scripts/background'); await flush();
    // Separate module instance models a UI context: only messages reach background.
    vi.resetModules(); storage = (await import('../src/scripts/counterStorage')).default;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('cross-context replacement versus periodic persistence', () => {
    it.each([{}, { [today]: day(100) }])('drains an already-started old save before replacement %j becomes authoritative', async replacement => {
        const pending = deferred<void>();
        const set = mock.browser.storage.local.set.getMockImplementation()!;
        mock.browser.storage.local.set.mockImplementationOnce(async values => {
            const snapshot = structuredClone(values); await pending.promise; await set(snapshot);
        });
        await ticks(15); expect(mock.data[today]).toBeUndefined();
        const complete = vi.fn(); const replacing = storage.overwriteStorage(replacement).then(complete);
        await flush(); expect(mock.browser.storage.local.remove).not.toHaveBeenCalled();
        await ticks(30); expect(mock.browser.storage.local.set).toHaveBeenCalledTimes(1);
        expect(complete).not.toHaveBeenCalled();
        pending.resolve(); await replacing;
        expect(JSON.parse(await storage.getAllJSONString())).toEqual(replacement);
        // No delayed old write remains able to restore/overwrite these values.
        await flush(); expect(JSON.parse(await storage.getAllJSONString())).toEqual(replacement);
        await ticks(15);
        expect(mock.data[today].netTime).toBe((replacement[today]?.netTime ?? 0) + 15);
        expect(mock.data.settings).toEqual(settings);
    });
    it('blocks new saves and accounting throughout removal/set, then resumes at the existing cadence', async () => {
        await ticks(1);
        const removeGate = deferred<void>(), setGate = deferred<void>();
        const remove = mock.browser.storage.local.remove.getMockImplementation()!;
        const set = mock.browser.storage.local.set.getMockImplementation()!;
        mock.browser.storage.local.remove.mockImplementationOnce(async keys => { await removeGate.promise; await remove(keys); });
        mock.browser.storage.local.set.mockImplementationOnce(async values => { await setGate.promise; await set(values); });
        const replacing = storage.overwriteStorage({ [today]: day(50) }); await flush();
        await ticks(29); expect(mock.browser.storage.local.set).not.toHaveBeenCalled();
        removeGate.resolve(); await flush();
        expect(mock.browser.storage.local.set).toHaveBeenCalledTimes(1);
        await ticks(30); expect(mock.browser.storage.local.set).toHaveBeenCalledTimes(1);
        setGate.resolve(); await replacing;
        expect(mock.data[today]).toEqual(day(50));
        await ticks(14); expect(mock.data[today]).toEqual(day(50));
        await ticks(1); expect(mock.data[today]).toEqual(day(65));
    });
    it.each(['get', 'remove', 'set'] as const)('recovers and resumes persistence after replacement %s fails', async phase => {
        mock.data[today] = day(8);
        mock.browser.storage.local[phase].mockRejectedValueOnce(new Error(`${phase} rejected`));
        const rejected = expect(storage.overwriteStorage({ [today]: day(100) })).rejects.toThrow(`${phase} rejected`);
        await rejected;
        const base = phase === 'set' ? 0 : 8; // set failure follows successful removal.
        await ticks(15);
        expect(mock.data[today]).toEqual(day(base + 15));
        await storage.overwriteStorage({});
        expect(JSON.parse(await storage.getAllJSONString())).toEqual({});
        await ticks(15); expect(mock.data[today]).toEqual(day(15));
    });
    it('failed reload does not restore the old counter and retries conservatively on a later tick', async () => {
        mock.data[today] = day(9);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mock.browser.storage.local.remove.mockRejectedValueOnce(new Error('remove rejected'));
        const get = mock.browser.storage.local.get.getMockImplementation()!;
        let failed = false;
        mock.browser.storage.local.get.mockImplementation(async keys => {
            if (keys === today && !failed) { failed = true; throw new Error('reload rejected'); }
            return get(keys);
        });
        await expect(storage.overwriteStorage({})).rejects.toThrow('remove rejected');
        expect(warn).toHaveBeenCalledWith('Counter reload after replacement failed', expect.any(Error));
        await ticks(1); expect(mock.data[today]).toEqual(day(9));
        await ticks(14); expect(mock.data[today]).toEqual(day(23)); // recovery tick earns no backfill.
    });
    it.each([false, true])('serializes two replacements without an older completion resuming the newer one (first fails=%s)', async firstFails => {
        const first = deferred<void>(), second = deferred<void>();
        const remove = mock.browser.storage.local.remove.getMockImplementation()!;
        mock.browser.storage.local.remove
            .mockImplementationOnce(async keys => { await first.promise; if (firstFails) throw new Error('first rejected'); await remove(keys); })
            .mockImplementationOnce(async keys => { await second.promise; await remove(keys); });
        const firstRequest = storage.overwriteStorage({ [today]: day(20) });
        const firstResult = firstRequest.then(() => 'ok', () => 'failed');
        const secondRequest = storage.overwriteStorage({ [today]: day(80) });
        await flush(); expect(mock.browser.storage.local.remove).toHaveBeenCalledTimes(1);
        first.resolve(); expect(await firstResult).toBe(firstFails ? 'failed' : 'ok'); await flush();
        expect(mock.browser.storage.local.remove).toHaveBeenCalledTimes(2);
        const writes = mock.browser.storage.local.set.mock.calls.length;
        await ticks(30); expect(mock.browser.storage.local.set).toHaveBeenCalledTimes(writes);
        second.resolve(); await secondRequest;
        expect(mock.data[today]).toEqual(day(80));
        await ticks(15); expect(mock.data[today]).toEqual(day(95));
    });
    it('invalidates accounting already awaiting a tab before imported replacement', async () => {
        const query = deferred<any>(); mock.browser.tabs.query.mockReturnValueOnce(query.promise);
        await ticks(1);
        await storage.overwriteStorage({ [today]: day(40), '2026 10 6': day(7) });
        query.resolve([mock.activeTabs.get(1)]); await flush();
        await ticks(14);
        expect(mock.data[today]).toEqual(day(54));
        expect(mock.data['2026 10 6']).toEqual(day(7));
    });
    it('handles pending periodic-write rejection before reset without hanging or unhandled rejection', async () => {
        const write = deferred<void>();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mock.browser.storage.local.set.mockReturnValueOnce(write.promise);
        await ticks(15);
        const reset = storage.overwriteStorage({}); await flush();
        write.reject(new Error('old write rejected')); await reset;
        expect(warn).toHaveBeenCalledWith('Counter save failed', expect.any(Error));
        expect(JSON.parse(await storage.getAllJSONString())).toEqual({});
        await ticks(15); expect(mock.data[today]).toEqual(day(15));
    });
    it('drains every overlapping pre-replacement save, even if they settle out of order', async () => {
        const first = deferred<void>(), second = deferred<void>();
        const set = mock.browser.storage.local.set.getMockImplementation()!;
        mock.browser.storage.local.set
            .mockImplementationOnce(async values => { const snapshot = structuredClone(values); await first.promise; await set(snapshot); })
            .mockImplementationOnce(async values => { const snapshot = structuredClone(values); await second.promise; await set(snapshot); });
        await ticks(30);
        const replacing = storage.overwriteStorage({ [today]: day(80) }); await flush();
        second.resolve(); await flush();
        expect(mock.browser.storage.local.remove).not.toHaveBeenCalled();
        first.resolve(); await replacing;
        expect(mock.data[today]).toEqual(day(80));
        await ticks(15); expect(mock.data[today]).toEqual(day(95));
    });
    it('coordinates merge imports with pending saves through the same background queue', async () => {
        const write = deferred<void>();
        const set = mock.browser.storage.local.set.getMockImplementation()!;
        let savedSeconds = 0;
        mock.browser.storage.local.set.mockImplementationOnce(async values => {
            const snapshot = structuredClone(values); savedSeconds = snapshot[today].netTime;
            await write.promise; await set(snapshot);
        });
        await ticks(15);
        const merged = storage.mergeStorage({ [today]: day(10) }); await flush();
        await ticks(15); expect(mock.browser.storage.local.set).toHaveBeenCalledTimes(1);
        write.resolve(); await merged;
        expect(mock.data[today]).toEqual(day(savedSeconds + 10));
        await ticks(15); expect(mock.data[today]).toEqual(day(savedSeconds + 25));
    });
    it('does not perform UI writes or report success without a background acknowledgement', async () => {
        mock.browser.runtime.sendMessage.mockResolvedValueOnce(undefined);
        await expect(storage.overwriteStorage({})).rejects.toThrow('not acknowledged');
        expect(mock.browser.storage.local.remove).not.toHaveBeenCalled();
        expect(mock.browser.storage.local.set).not.toHaveBeenCalled();
    });

    it('reset cannot resurrect the unsaved day absent from the captured removal keys', async () => {
        await ticks(1); expect(mock.data[today]).toBeUndefined();
        const removal = deferred<void>();
        const remove = mock.browser.storage.local.remove.getMockImplementation()!;
        mock.browser.storage.local.remove.mockImplementationOnce(async keys => {
            expect(keys).toEqual([]); await removal.promise; await remove(keys);
        });
        const reset = storage.overwriteStorage({}); await flush();
        expect(mock.browser.storage.local.remove).toHaveBeenCalledWith([]);
        await ticks(14);
        // Before the fix the old counter is written here, outside captured keys.
        removal.resolve(); await reset; await flush();
        expect(JSON.parse(await storage.getAllJSONString())).toEqual({});
        expect(mock.data[today]).toBeUndefined();
    });
});
