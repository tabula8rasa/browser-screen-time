import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMock, settings } from './helpers/browserMock';
import type { CounterDailyData } from '../src/scripts/counter';
import { encodeDailyData } from '../src/scripts/dailyDataCodec';

let mock: ReturnType<typeof createBrowserMock>;
let storage: typeof import('../src/scripts/counterStorage').default;
const today = '2026 10 7';
function day(websiteTime: Record<string, number>): CounterDailyData {
    return { netTime: Object.values(websiteTime).reduce((sum, seconds) => sum + seconds, 0), websiteTime,
        colors: ['#227C9D', '#17C3B2', '#FFCB77', '#FE6D73'], otherColor: '#CFCFCF' };
}
beforeEach(async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 7, 12));
    mock = createBrowserMock(); mock.data.settings = { ...settings };
    mock.browser.runtime.sendMessage = vi.fn(async (message: any) => { return mock.browser.runtime.onMessage.emit(message).find(result => result !== undefined); });
    vi.doMock('webextension-polyfill', () => ({ default: mock.browser }));
    storage = (await import('../src/scripts/counterStorage')).default;
    // Unit tests exercise the storage phase through the real request/reply API.
    // Background locking/pending writes are covered by replacementPersistence.
    storage.onReplacement(async request => { await storage.replaceInBackground(request); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('daily data import merge', () => {
    it('adds overlapping days/domains, retains untouched history, and inserts new domains/days', async () => {
        Object.assign(mock.data, { [today]: day({ '127.0.0.1': 903, 'example.net': 10 }),
            '2026 10 6': day({ 'past.example': 25 }), '2026 9 7': day({ 'boundary.example': 15 }),
            '2026 9 6': day({ 'outside.example': 777 }) });
        const imported = { [today]: day({ '127.0.0.1': 3, 'merge-new.example': 4 }),
            '2026 10 6': day({ 'past.example': 5 }), '2026 10 5': day({ 'new-day.example': 9 }) };
        const beforeImport = structuredClone(imported);
        await storage.mergeStorage(imported);
        expect(mock.data).toEqual({ settings, [today]: day({ '127.0.0.1': 906, 'example.net': 10, 'merge-new.example': 4 }),
            '2026 10 6': day({ 'past.example': 30 }), '2026 10 5': day({ 'new-day.example': 9 }),
            '2026 9 7': day({ 'boundary.example': 15 }), '2026 9 6': day({ 'outside.example': 777 }) });
        expect(imported).toEqual(beforeImport);
        expect(mock.browser.runtime.sendMessage).toHaveBeenCalledWith({ type: 'counter:replace', mode: 'merge', data: imported });
        expect(JSON.parse(await storage.getAllJSONString())).toEqual(Object.fromEntries(Object.entries(mock.data).filter(([key]) => key !== 'settings')));
    });

    it('does not mutate either input snapshot, including nested domain maps', async () => {
        const existing = day({ old: 2 }); const incoming = day({ old: 3, added: 4 });
        Object.freeze(existing.websiteTime); Object.freeze(existing);
        Object.freeze(incoming.websiteTime); Object.freeze(incoming);
        const read = mock.browser.storage.local.get.getMockImplementation()!;
        mock.browser.storage.local.get.mockImplementation(async keys => keys === undefined
            ? { [today]: existing, settings } : { [today]: existing });
        await storage.mergeStorage(Object.freeze({ [today]: incoming }));
        expect(existing).toEqual(day({ old: 2 })); expect(incoming).toEqual(day({ old: 3, added: 4 }));
        expect(mock.data[today]).toEqual(day({ old: 5, added: 4 }));
        mock.browser.storage.local.get.mockImplementation(read);
    });

    it('empty import preserves all history and notifies the tracker with the existing current day', async () => {
        mock.data[today] = day({ old: 5 }); mock.data['2026 10 6'] = day({ previous: 6 });
        const before = structuredClone(mock.data);
        await storage.mergeStorage({});
        expect(mock.data).toEqual(before);
        expect(mock.browser.runtime.sendMessage).toHaveBeenCalledWith({ type: 'counter:replace', mode: 'merge', data: {} });
    });

    it('supports import into empty history and preserves zero-valued domains', async () => {
        await storage.mergeStorage({ [today]: day({ a: 0, b: 3 }) });
        await storage.mergeStorage({ [today]: day({ a: 2, b: 0, c: 0 }) });
        expect(mock.data).toEqual({ settings, [today]: day({ a: 2, b: 3, c: 0 }) });
    });

    it('historical-only import preserves the running current day', async () => {
        mock.data[today] = day({ current: 10 });
        await storage.mergeStorage({ '2026 10 6': day({ historical: 5 }) });
        expect((await storage.get()).websiteTime).toEqual({ current: 10 });
        expect(mock.data[today]).toEqual(day({ current: 10 }));
    });

    it('rejects invalid import before writing data or notifying the tracker', async () => {
        mock.data[today] = day({ old: 10 });
        await expect(storage.mergeStorage({ [today]: { ...day({ new: 2 }), netTime: 3 } })).rejects.toThrow('does not match');
        expect(mock.data[today]).toEqual(day({ old: 10 }));
        expect(mock.browser.storage.local.set).not.toHaveBeenCalled();
        expect(mock.browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it('handles domain names that coincide with inherited object properties', async () => {
        mock.data[today] = day({ ordinary: 3 });
        await storage.mergeStorage({ [today]: day(JSON.parse('{"constructor":2,"__proto__":4}')) });
        expect(mock.data[today]).toEqual(encodeDailyData(day(JSON.parse('{"ordinary":3,"constructor":2,"__proto__":4}'))));
    });
});
