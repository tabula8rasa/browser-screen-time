import { afterEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import Counter from '../src/scripts/counter';
import CounterStorage from '../src/scripts/counterStorage';
import Utils from '../src/scripts/utils';
import { subDays } from 'date-fns';

vi.mock('webextension-polyfill', () => ({ default: { storage: { local: { get: vi.fn() } } } }));
afterEach(() => { vi.useRealTimers(); });
const websites = { 'example.com': 227, 'www.youtube.com': 157, '127.0.0.1': 104, 'example.org': 49, 'example.net': 34 };

describe('popup domain aggregation', () => {
    it('includes the fifth domain in other without adding a phantom second', () => {
        const counter = new Counter(571, { ...websites });
        const displayed = counter.mostUsed();
        expect(displayed.at(-1)).toMatchObject({ url: 'other', time: 34, percentage: 34 / 571 * 100 });
        expect(displayed.reduce((total, site) => total + site.time, 0)).toBe(571);
        expect(counter.websiteTime).toEqual(websites);
    });
    it('sums every remaining domain when more than five domains exist', () => {
        const counter = new Counter(583, { ...websites, 'sixth.test': 10, 'seventh.test': 2 });
        const displayed = counter.mostUsed();
        expect(displayed.at(-1).time).toBe(46);
        expect(displayed.reduce((total, site) => total + site.time, 0)).toBe(counter.netTime);
    });
    it('preserves four individual sites without inventing an other row', () => {
        const counter = new Counter(10, { a: 1, b: 2, c: 3, d: 4 });
        expect(counter.mostUsed().map(site => site.url)).toEqual(['d', 'c', 'b', 'a']);
        expect(counter.mostUsed().reduce((total, site) => total + site.time, 0)).toBe(10);
    });
    it('keeps a zero-second remainder at zero', () => {
        expect(new Counter(10, { a: 1, b: 2, c: 3, d: 4, e: 0 }).mostUsed().at(-1).time).toBe(0);
    });
});

describe('stored popup period boundaries', () => {
    it.each([
        ['Today', 0, 571],
        ['This week', 7, 631],
        ['This month', 30, 671]
    ])('%s includes its existing inclusive date range and excludes outside data', async (_label, days: number, expected: number) => {
        vi.useFakeTimers();
        const today = new Date(2026, 9, 7, 12);
        vi.setSystemTime(today);
        const data: Record<string, Counter> = {
            [Utils.formatDate(today)]: new Counter(571, { ...websites }),
            [Utils.formatDate(subDays(today, 1))]: new Counter(40, { 'previous.test': 40 }),
            [Utils.formatDate(subDays(today, 7))]: new Counter(20, { 'week-boundary.test': 20 }),
            [Utils.formatDate(subDays(today, 8))]: new Counter(30, { 'outside-week.test': 30 }),
            [Utils.formatDate(subDays(today, 30))]: new Counter(10, { 'month-boundary.test': 10 }),
            [Utils.formatDate(subDays(today, 31))]: new Counter(999, { 'too-old.test': 999 }),
            [Utils.formatDate(subDays(today, -1))]: new Counter(888, { 'future.test': 888 })
        };
        vi.mocked(browser.storage.local.get).mockImplementation(async key => ({ [key as string]: data[key as string] }));
        const counter = await CounterStorage.get([subDays(today, days), today]);
        expect(counter.netTime).toBe(expected);
        expect(counter.websiteTime['too-old.test']).toBeUndefined();
        expect(counter.websiteTime['future.test']).toBeUndefined();
        expect(counter.mostUsed().reduce((total, site) => total + site.time, 0)).toBe(expected);
    });
});
