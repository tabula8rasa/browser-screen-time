import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMock, flush, settings } from './helpers/browserMock';
import type Counter from '../src/scripts/counter';
import type { CounterDailyData } from '../src/scripts/counter';

let mock: ReturnType<typeof createBrowserMock>;
const today = '2026 10 7';
const names = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'example.com'];
function day(entries: Array<[string, number]>): CounterDailyData {
    return { netTime: entries.reduce((sum, [, n]) => sum + n, 0), websiteTime: Object.fromEntries(entries),
        colors: ['#227C9D', '#17C3B2', '#FFCB77', '#FE6D73'], otherColor: '#CFCFCF' };
}
function ownNumber(map: object, key: string, value: number) {
    expect(Object.getOwnPropertyDescriptor(map, key)).toMatchObject({ value, enumerable: true });
    expect(typeof Object.getOwnPropertyDescriptor(map, key)?.value).toBe('number');
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
}
beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 7, 12));
    mock = createBrowserMock(); mock.data.settings = { ...settings, notifications: true, notificationTimer: '1' };
    mock.browser.runtime.sendMessage.mockImplementation(async msg => { return mock.browser.runtime.onMessage.emit(msg).find(result => result !== undefined); });
    vi.doMock('webextension-polyfill', () => ({ default: mock.browser }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('prototype-safe domain accounting', () => {
    it.each(names)('fresh counter arithmetic for %s stays numeric through repeated ticks', async name => {
        const { default: Counter } = await import('../src/scripts/counter');
        const counter = new Counter();
        for (let n = 1; n <= 3; n++) {
            expect(counter.addSecond(name)).toBe(n);
            ownNumber(counter.websiteTime, name, n);
            expect(counter.netTime).toBe(n);
            expect(Object.keys(counter.websiteTime)).toEqual([name]);
        }
    });
    it('never invokes arbitrary inherited getters/setters or mutates the destination prototype', async () => {
        const { addDomainSeconds, copyDomainTimes } = await import('../src/scripts/domainTime');
        const getter = vi.fn(() => 900), setter = vi.fn();
        const prototype = Object.create(Object.prototype);
        Object.defineProperty(prototype, 'arbitrary.example', { get: getter, set: setter });
        const map = Object.create(prototype);
        for (let n = 1; n <= 3; n++) {
            expect(addDomainSeconds(map, 'arbitrary.example', 1)).toBe(n);
            expect(Object.getOwnPropertyDescriptor(map, 'arbitrary.example')?.value).toBe(n);
            expect(Object.getPrototypeOf(map)).toBe(prototype);
        }
        expect(getter).not.toHaveBeenCalled(); expect(setter).not.toHaveBeenCalled();
        const copied = copyDomainTimes(map); ownNumber(copied, 'arbitrary.example', 3);
        expect(Object.getPrototypeOf(prototype)).toBe(Object.prototype);
    });
    it('normalizes only own domain data, including every Object.prototype name', async () => {
        const { default: Counter } = await import('../src/scripts/counter');
        const inherited = { 'inherited.example': 80 };
        const map = Object.create(inherited);
        Object.defineProperty(map, '__proto__', { value: 2, enumerable: true });
        const counter = new Counter(2, map);
        expect(Object.keys(counter.websiteTime)).toEqual(['__proto__']);
        for (const name of Object.getOwnPropertyNames(Object.prototype)) {
            const before = name === '__proto__' ? 2 : 0;
            expect(counter.addSecond(name)).toBe(before + 1);
            ownNumber(counter.websiteTime, name, before + 1);
        }
        expect(Object.getPrototypeOf(map)).toBe(inherited);
        expect(inherited).toEqual({ 'inherited.example': 80 });
    });

    it.each(['constructor', '__proto__', 'example.com'])('fresh real accounting credits own numeric %s at 1/2/3', async hostname => {
        mock.activeTabs.get(1).url = `https://${hostname}/`;
        const { default: storage } = await import('../src/scripts/counterStorage');
        const read = storage.get.bind(storage); let live!: Counter;
        vi.spyOn(storage, 'get').mockImplementation(async interval => { live = await read(interval); return live; });
        await import('../src/scripts/background'); await flush();
        for (let n = 1; n <= 3; n++) {
            await vi.advanceTimersByTimeAsync(1000); await flush();
            ownNumber(live.websiteTime, hostname, n); expect(live.netTime).toBe(n);
            expect(Object.keys(live.websiteTime)).toEqual([hostname]);
            expect(mock.browser.notifications.create.mock.calls[n - 1][0].message).toBe(`You have already spent ${n}s on ${hostname}!`);
        }
        await vi.advanceTimersByTimeAsync(12000); await flush();
        const stored = mock.data[today];
        ownNumber(stored.websiteTime, hostname, stored.netTime);
        expect(Object.keys(stored.websiteTime)).toEqual([hostname]);
        const reloaded = await storage.get(); ownNumber(reloaded.websiteTime, hostname, stored.netTime);
    });
    it.each(['constructor', '__proto__'])('stored and overwritten %s counters resume numeric accounting and notifications', async hostname => {
        mock.activeTabs.get(1).url = `https://${hostname}/`;
        mock.data[today] = JSON.parse(JSON.stringify(day([[hostname, 2]])));
        const { default: storage } = await import('../src/scripts/counterStorage');
        const read = storage.get.bind(storage); let live!: Counter;
        vi.spyOn(storage, 'get').mockImplementation(async interval => { live = await read(interval); return live; });
        await import('../src/scripts/background'); await flush();
        await vi.advanceTimersByTimeAsync(1000); await flush();
        ownNumber(live.websiteTime, hostname, 3); expect(live.netTime).toBe(3);
        expect(mock.browser.notifications.create.mock.calls[0][0].message).toContain(`3s on ${hostname}!`);
        const imported = JSON.parse(JSON.stringify({ [today]: day([[hostname, 10]]) }));
        await storage.overwriteStorage(imported); await flush();
        await vi.advanceTimersByTimeAsync(1000); await flush();
        expect(mock.browser.notifications.create.mock.calls[1][0].message).toContain(`11s on ${hostname}!`);
        await vi.advanceTimersByTimeAsync(13000); await flush();
        const saved = mock.data[today];
        ownNumber(saved.websiteTime, hostname, saved.netTime); expect(saved.netTime).toBeGreaterThan(10);
        ownNumber(imported[today].websiteTime, hostname, 10);
    });
    it('aggregates all inherited-name keys across ordinary serialized daily objects', async () => {
        const { default: storage } = await import('../src/scripts/counterStorage');
        mock.data[today] = JSON.parse(JSON.stringify(day(names.map(name => [name, 2]))));
        mock.data['2026 10 6'] = JSON.parse(JSON.stringify(day(names.map(name => [name, 3]))));
        const result = await storage.get([new Date(2026, 9, 6), new Date(2026, 9, 7)]);
        names.forEach(name => ownNumber(result.websiteTime, name, 5));
        expect(result.netTime).toBe(names.length * 5);
        expect(Object.getPrototypeOf(mock.data[today].websiteTime)).toBe(Object.prototype);
        expect(result.mostUsed().reduce((sum, site) => sum + site.time, 0)).toBe(result.netTime);
    });
    it('stored/imported own keys survive export, overwrite, merge, and reload without prototype mutation', async () => {
        await import('../src/scripts/background'); await flush();
        const { default: storage } = await import('../src/scripts/counterStorage');
        const input = JSON.parse(JSON.stringify({ [today]: day(names.map(name => [name, 2])) }));
        const before = structuredClone(input); await storage.overwriteStorage(input);
        const exported = JSON.parse(await storage.getAllJSONString()); expect(exported).toEqual(input);
        expect(exported.settings).toBeUndefined();
        names.forEach(name => ownNumber(exported[today].websiteTime, name, 2));
        await storage.overwriteStorage(exported);
        await storage.mergeStorage(JSON.parse(JSON.stringify({ [today]: day(names.map(name => [name, 3])) })));
        const loaded = await storage.get(); names.forEach(name => ownNumber(loaded.websiteTime, name, 5));
        expect(loaded.netTime).toBe(names.length * 5); expect(input).toEqual(before);
        names.forEach(name => expect(loaded.addSecond(name)).toBe(6));
        expect(loaded.netTime).toBe(names.length * 6); await storage.set(loaded);
        const merged = JSON.parse(await storage.getAllJSONString());
        names.forEach(name => ownNumber(merged[today].websiteTime, name, 6));
        expect(Object.getPrototypeOf(input[today].websiteTime)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(mock.data[today].websiteTime)).toBe(Object.prototype);
    });
});
