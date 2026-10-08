import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeDailyData, encodeDailyData } from '../src/scripts/dailyDataCodec';
import type { CounterDailyData } from '../src/scripts/counter';
import { createBrowserMock, flush, settings } from './helpers/browserMock';
const names = Object.getOwnPropertyNames(Object.prototype);
const today = '2026 10 7';
function day(map: Record<string, number>): CounterDailyData { return { netTime: Object.values(map).reduce((a, b) => a + b, 0), websiteTime: map, colors: ['#227C9D', '#17C3B2', '#FFCB77', '#FE6D73'], otherColor: '#CFCFCF' }; }
function normalize(value: any): any {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !names.includes(key)).map(([key, item]) => [key, normalize(item)]));
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('daily reserved hostname codec', () => {
    it('preserves accepted legacy fractions across ticking, periodic persistence, reload and both exports/reimport', async () => {
        vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 7, 12));
        const mock = createBrowserMock(); mock.data.settings = {...settings};
        mock.activeTabs.set(1, {id: 10, windowId: 1, active: true, url: 'https://a.test/'});
        mock.browser.runtime.sendMessage.mockImplementation(async message => normalize(await mock.browser.runtime.onMessage.emit(message).find(value => value !== undefined)));
        vi.doMock('webextension-polyfill', () => ({default: mock.browser}));
        const {SessionHistory} = await import('../src/scripts/sessionHistory'); let history: InstanceType<typeof SessionHistory>;
        const start = SessionHistory.prototype.start;
        vi.spyOn(SessionHistory.prototype, 'start').mockImplementation(function () { history = this; start.call(this); });
        const storage = (await import('../src/scripts/counterStorage')).default;
        const {parseTransfer} = await import('../src/scripts/dataTransfer');
        await import('../src/scripts/background'); await flush(); await history!.settled();
        try {
            await storage.overwriteStorage({[today]: day({'a.test': 0.1, 'b.test': 0.1})}); await history!.settled();
            await vi.advanceTimersByTimeAsync(15000); await flush();
            const saved = structuredClone(mock.data[today]);
            expect(saved.netTime).toBe(15.2); expect(saved.websiteTime).toEqual({'a.test': 15.1, 'b.test': 0.1});
            expect(await storage.getSingleDay(new Date())).toEqual(saved);
            expect((await storage.get()).netTime).toBe(saved.netTime);
            for (const mode of ['daily', 'full'] as const) {
                const exported = JSON.parse(await storage.exportJSONString(mode));
                expect(parseTransfer(exported, 'overwrite').daily).toEqual({[today]: saved});
                await storage.overwriteStorage(exported); await history!.settled();
                expect(mock.data[today]).toEqual(saved);
            }
            await storage.mergeStorage({[today]: day({'b.test': 0.1})}); await history!.settled();
            expect((await storage.get()).websiteTime).toEqual({'a.test': 15.1, 'b.test': 0.2});
            expect(parseTransfer(JSON.parse(await storage.exportJSONString('daily')), 'overwrite').daily[today].websiteTime).toEqual({'a.test': 15.1, 'b.test': 0.2});
        } finally { history!.stop(); }
    });

    it('keeps ordinary shape exact and legacy reserved maps, regenerates and deduplicates tuple protection', () => {
        const ordinary = day({'normal.test': 3}); expect(encodeDailyData(ordinary)).toEqual(ordinary);
        const raw = day(Object.fromEntries(names.map((name, index) => [name, index + 1])));
        const encoded = encodeDailyData(raw); expect(encoded.websiteTime).toEqual(raw.websiteTime);
        expect(encoded.websiteTimeReserved).toEqual(names.map((name, index) => [name, index + 1]));
        expect(encodeDailyData(encoded)).toEqual(encoded); expect(decodeDailyData(encoded)).toEqual(raw);
        expect(decodeDailyData(normalize(encoded))).toEqual(raw);
        expect(encodeDailyData({...raw, websiteTimeReserved: [['constructor', 999]]})).toEqual(encoded);
    });
    it.each([
        [['constructor', 1], ['constructor', 1]], [['normal.test', 1]], [['constructor', -1]], [['constructor', Infinity]], [['constructor']], ['constructor'], null, undefined
    ].map(entries => ({entries})))('rejects malformed reserved tuples $entries', ({entries}) => {
        expect(() => decodeDailyData({...day({constructor: 1}), websiteTimeReserved: entries})).toThrow();
    });
    it('rejects conflicting or irrecoverably missing values without changing input', () => {
        const raw = {...day({constructor: 1}), websiteTimeReserved: [['constructor', 2]]}; const before = structuredClone(raw);
        expect(() => decodeDailyData(raw)).toThrow('Conflicting'); expect(raw).toEqual(before);
        expect(() => decodeDailyData(normalize(day({constructor: 1})))).toThrow('does not match');
    });
    it('protects all reserved names through native-like storage reads, merge, periodic save and JSON RPC', async () => {
        vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 7, 12));
        const mock = createBrowserMock(); mock.data.settings = {...settings};
        const read = mock.browser.storage.local.get.getMockImplementation()!;
        mock.browser.storage.local.get.mockImplementation(async keys => normalize(await read(keys)));
        mock.browser.runtime.sendMessage.mockImplementation(async message => normalize(await mock.browser.runtime.onMessage.emit(message).find(value => value !== undefined)));
        vi.doMock('webextension-polyfill', () => ({default: mock.browser}));
        const {SessionHistory} = await import('../src/scripts/sessionHistory'); let history: InstanceType<typeof SessionHistory>;
        const start = SessionHistory.prototype.start;
        vi.spyOn(SessionHistory.prototype, 'start').mockImplementation(function () { history = this; start.call(this); });
        const storage = (await import('../src/scripts/counterStorage')).default;
        await import('../src/scripts/background'); await flush(); await history!.settled();
        try {
            const raw = day(Object.fromEntries(names.map(name => [name, 2])));
            await storage.overwriteStorage({[today]: raw}); await storage.mergeStorage({[today]: raw}); await history!.settled();
            const merged = day(Object.fromEntries(names.map(name => [name, 4])));
            expect((await storage.get()).websiteTime).toEqual(merged.websiteTime);
            expect(await storage.getSingleDay(new Date())).toEqual(merged);
            expect(await storage.savedData()).toEqual({[today]: merged});
            const {parseTransfer} = await import('../src/scripts/dataTransfer');
            expect(parseTransfer({[today]: encodeDailyData(merged)}, 'overwrite').daily).toEqual({[today]: merged});
            for (const mode of ['daily', 'full'] as const) {
                const exported = JSON.parse(await storage.exportJSONString(mode));
                const daily = mode === 'full' ? exported.dailyAggregates : exported;
                expect(daily).toEqual({[today]: merged}); expect(daily[today].websiteTimeReserved).toBeUndefined();
            }
            await vi.advanceTimersByTimeAsync(15000); await flush();
            expect((await storage.get()).websiteTime).toEqual({...merged.websiteTime, 'github.com': 15});
            expect(mock.data[today].websiteTimeReserved).toHaveLength(names.length);
            const before = structuredClone(mock.data);
            await expect(storage.overwriteStorage({[today]: {...raw, websiteTimeReserved: [['constructor', 99]]}})).rejects.toThrow('Conflicting');
            expect(mock.data).toEqual(before);
        } finally { history!.stop(); }
    });
});
