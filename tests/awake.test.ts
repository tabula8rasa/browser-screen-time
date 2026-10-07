import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMock, deferred, flush, settings } from './helpers/browserMock';

let mock: ReturnType<typeof createBrowserMock>;
beforeEach(() => { vi.resetModules(); mock = createBrowserMock(); mock.data.settings = settings; vi.doMock('webextension-polyfill', () => ({ default: mock.browser })); });
afterEach(() => vi.restoreAllMocks());

describe('idle-only Awake', () => {
    it('starts conservative, queries the saved interval, maps idle/locked and active', async () => {
        const initial = deferred<string>(); mock.browser.idle.queryState.mockReturnValueOnce(initial.promise);
        const { default: Awake } = await import('../src/scripts/awake'); const changed = vi.fn(); const awake = new Awake(changed);
        await flush(); expect(awake.initialized).toBe(false); expect(awake.idle).toBe(true);
        expect(mock.browser.idle.setDetectionInterval).toHaveBeenCalledWith(15);
        initial.resolve('active'); await flush(); expect(awake.initialized).toBe(true); expect(awake.idle).toBe(false);
        for (const state of ['idle', 'locked']) { mock.browser.idle.onStateChanged.emit(state); expect(awake.idle).toBe(true); }
        mock.browser.idle.onStateChanged.emit('active'); expect(awake.idle).toBe(false); expect(changed).toHaveBeenCalled();
    });
    it('a newer idle event beats an old query and settings queries resolve in generation order', async () => {
        const initial = deferred<string>(); mock.browser.idle.queryState.mockReturnValueOnce(initial.promise);
        const { default: Awake } = await import('../src/scripts/awake'); const awake = new Awake(() => {}); await flush();
        mock.browser.idle.onStateChanged.emit('idle'); initial.resolve('active'); await flush(); expect(awake.idle).toBe(true);
        const old = deferred<string>(); const latest = deferred<string>();
        mock.browser.idle.queryState.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
        mock.browser.runtime.onMessage.emit({ type: 'settings', settings: { ...settings, idleTimer: '20' } });
        mock.browser.runtime.onMessage.emit({ type: 'settings', settings: { ...settings, idleTimer: '30' } });
        latest.resolve('active'); await flush(); old.resolve('idle'); await flush(); expect(awake.idle).toBe(false);
        expect(mock.browser.idle.setDetectionInterval).toHaveBeenLastCalledWith(30);
    });
    it('settings events cannot be overwritten by delayed initial settings load', async () => {
        const load = deferred<any>(); mock.browser.storage.local.get.mockReturnValueOnce(load.promise);
        const { default: Awake } = await import('../src/scripts/awake'); new Awake(() => {});
        mock.browser.runtime.onMessage.emit({ type: 'settings', settings: { ...settings, idleTimer: '30' } });
        load.resolve({ settings }); await flush(); expect(mock.browser.idle.setDetectionInterval).toHaveBeenCalledTimes(1);
        expect(mock.browser.idle.queryState).toHaveBeenCalledWith(30);
    });
});
