import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMock, deferred, flush, settings } from './helpers/browserMock';
let mock: ReturnType<typeof createBrowserMock>;
let history: import('../src/scripts/sessionHistory').SessionHistory;
let transfer: typeof import('../src/scripts/counterStorage').default;
const today = '2026 10 7';
const day = (n: number) => ({ netTime: n, websiteTime: { 'github.com': n }, colors: ['#227C9D', '#17C3B2', '#FFCB77', '#FE6D73'], otherColor: '#CFCFCF' });
async function ticks(n: number) { await vi.advanceTimersByTimeAsync(n * 1000); await flush(); }
async function exportData(mode: 'full' | 'daily') { const reply: any = await mock.browser.runtime.sendMessage({type: 'data:export', mode}); return reply.ok ? {ok: true, data: JSON.parse(reply.json)} : reply; }
beforeEach(async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 7, 12));
    mock = createBrowserMock(); mock.data.settings = {...settings};
    mock.browser.runtime.sendMessage.mockImplementation(async message => mock.browser.runtime.onMessage.emit(message).find(value => value !== undefined));
    vi.doMock('webextension-polyfill', () => ({default: mock.browser}));
    const {SessionHistory} = await import('../src/scripts/sessionHistory');
    const start = SessionHistory.prototype.start;
    vi.spyOn(SessionHistory.prototype, 'start').mockImplementation(function () { history = this; start.call(this); });
    transfer = (await import('../src/scripts/counterStorage')).default;
    await import('../src/scripts/background'); await flush(); await history.settled();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { history.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('background history failure and transfer ordering', () => {
    it.each(['open', 'control'] as const)('corrupt %s preflight rejects before any mutation and retains unsaved live seconds', async kind => {
        const {idbRequest, SessionStorage} = await import('../src/scripts/sessionStorage');
        await ticks(7); mock.data['2026 10 6'] = day(17);
        await history.storage.transaction('readwrite', async tx => {
            const metadata = tx.objectStore('metadata');
            if (kind === 'open') await idbRequest(metadata.put({key: 'open', sessionId: 999, ownerRunId: 'bad', generation: 1}));
            else { const control = await idbRequest(metadata.get('control')); control.lastObservedAt = -1; await idbRequest(metadata.put(control)); }
        });
        await expect(transfer.overwriteStorage({})).rejects.toThrow(/Corrupt/);
        expect(mock.browser.storage.local.remove).not.toHaveBeenCalled();
        expect(mock.data['2026 10 6']).toEqual(day(17));
        const inspect = new SessionStorage(); await inspect.open();
        try { await inspect.transaction('readonly', async tx => { expect(await idbRequest(tx.objectStore('metadata').get('replacement'))).toBeUndefined(); }); } finally { inspect.close(); }
        await ticks(8); expect(mock.data[today]).toEqual(day(15));
    });

    it('pre-intent timeout preserves unsaved live accounting and every saved daily key', async () => {
        mock.data['2026 10 6'] = day(17); await ticks(7);
        const gate = deferred<void>(), entered = deferred<void>();
        const open = history.storage.open.bind(history.storage);
        vi.spyOn(history.storage, 'open').mockImplementationOnce(async () => { entered.resolve(); await gate.promise; await open(); });
        const result = transfer.overwriteStorage({}).then(() => 'ok', error => error.message);
        await entered.promise; await ticks(10); expect(await result).toMatch(/10 seconds/);
        expect(mock.data['2026 10 6']).toEqual(day(17)); expect(mock.browser.storage.local.remove).not.toHaveBeenCalled();
        await ticks(13); expect(mock.data[today]).toEqual(day(20));
        gate.resolve(); await flush();
    });
    it('unknown finalization resumes daily accounting but rejects full export until recovery', async () => {
        const gate = deferred<void>(), entered = deferred<void>();
        const finalize = history.storage.finalize.bind(history.storage);
        vi.spyOn(history.storage, 'finalize').mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; await finalize(...args); });
        vi.spyOn(history.storage, 'abort').mockImplementation(() => {});
        const result = transfer.overwriteStorage({[today]: day(40)}).then(() => 'ok', error => error.message);
        await entered.promise; await ticks(10); expect(await result).toMatch(/partially completed/);
        await ticks(5); expect(mock.data[today]).toEqual(day(55));
        expect(await exportData('full')).toMatchObject({ok: false, error: expect.stringMatching(/recovery pending/)});
        expect(await exportData('daily')).toMatchObject({ok: true, data: {[today]: day(55)}});
        gate.resolve(); await flush(); await ticks(1); await history.settled();
        expect(await exportData('full')).toMatchObject({ok: true});
    });
    it('failed export followed by delayed export fences a queued replacement until snapshot settlement', async () => {
        mock.browser.storage.local.get.mockRejectedValueOnce(new Error('export read rejected'));
        expect(await exportData('daily')).toMatchObject({ok: false});
        const gate = deferred<void>(), entered = deferred<void>();
        const snapshot = history.storage.snapshot.bind(history.storage);
        vi.spyOn(history.storage, 'snapshot').mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return snapshot(); });
        const exporting = exportData('full'); await entered.promise;
        const resetting = transfer.overwriteStorage({}); await flush();
        expect(mock.browser.storage.local.remove).not.toHaveBeenCalled();
        gate.resolve(); expect(await exporting).toMatchObject({ok: true}); await resetting;
        expect(await exportData('daily')).toEqual({ok: true, data: {}});
    });
    it('a rejected IndexedDB write cannot stop basic daily tracking', async () => {
        vi.spyOn(history.storage, 'apply').mockRejectedValueOnce(new Error('IDB unavailable'));
        mock.browser.windows.onFocusChanged.emit(-1); await history.settled();
        mock.browser.windows.onFocusChanged.emit(1); await flush(); await ticks(15);
        expect(mock.data[today]).toEqual(day(15));
    });
});
