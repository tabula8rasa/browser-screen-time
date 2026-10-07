import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMock, deferred, flush } from './helpers/browserMock';
import Counter from '../src/scripts/counter';

let mock: ReturnType<typeof createBrowserMock>;
let storage: typeof import('../src/scripts/counterStorage').default;
beforeEach(async () => {
    vi.resetModules(); mock = createBrowserMock();
    vi.doMock('webextension-polyfill', () => ({ default: mock.browser }));
    storage = (await import('../src/scripts/counterStorage')).default;
});
afterEach(() => vi.restoreAllMocks());

describe('persistence write completion', () => {
    it('propagates an actual rejected storage write to the caller', async () => {
        mock.browser.storage.local.set.mockRejectedValueOnce(new Error('write rejected'));
        await expect(storage.set(new Counter())).rejects.toThrow('write rejected');
    });
    it('remains pending until the actual delayed storage write completes', async () => {
        const write = deferred<any>(); mock.browser.storage.local.set.mockReturnValueOnce(write.promise);
        const settled = vi.fn(); const pending = storage.set(new Counter(2, { a: 2 })).then(settled);
        await flush(); expect(settled).not.toHaveBeenCalled();
        write.resolve(undefined); await pending; expect(settled).toHaveBeenCalledTimes(1);
    });
});
