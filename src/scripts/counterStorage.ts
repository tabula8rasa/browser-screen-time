import Utils from './utils'
import Counter, { CounterDailyData, CounterData } from './counter'
import { CounterOverwriteEvent, CounterReplacementRequest, CounterReplacementResponse, CounterTimespanInterval, MsgEvent } from './types'
import browser from 'webextension-polyfill'
import { isEqual, addDays, isAfter } from 'date-fns'
import { addDomainSeconds, copyDomainTimes } from './domainTime';
import { parseTransfer } from './dataTransfer';
import { decodeDailyData, decodeDailyMap, encodeDailyData, encodeDailyMap } from './dailyDataCodec';

export default class CounterStorage {
    static async set(counter: Counter) {
        await browser.storage.local.set({ [Utils.getTodaysDate()]: encodeDailyData(counter) });
    }

    static async getSingleDay(date: Date): Promise<CounterDailyData> {
        const key = Utils.formatDate(date);
        const data = (await browser.storage.local.get(key))[key];
        return data ? decodeDailyData(data) : data;
    }

    static async get(interval: CounterTimespanInterval = [new Date, new Date]): Promise<Counter> {
        if (isEqual(interval[0], interval[1])) {
            const data = await this.getSingleDay(interval[0]);

            if (data) {
                return new Counter(data.netTime, data.websiteTime);
            }

            return new Counter;
        }

        let accumalativeCounter = new Counter;

        let currentDate = interval[0];
        while (!isAfter(currentDate, interval[1])) {
            const data = await this.getSingleDay(currentDate);

            if (data) {
                accumalativeCounter.netTime += data.netTime;
                for (let [url, time] of Object.entries(data.websiteTime)) {
                    addDomainSeconds(accumalativeCounter.websiteTime, url, time);
                }
            }

            currentDate = addDays(currentDate, 1);
        }

        return accumalativeCounter;
    }


    static onOverwrite(callback: (counterData: CounterDailyData | null) => void): void {
        browser.runtime.onMessage.addListener((message: MsgEvent) => {
            if (message.type !== 'counter') {
                return;
            }

            callback((message as CounterOverwriteEvent).counter);
        });
    }

    static async getAllJSONString(): Promise<string> {
        return JSON.stringify(await this.savedData());
    }

    static async savedData(): Promise<CounterData> {
        const allData = await browser.storage.local.get();
        return decodeDailyMap(Object.fromEntries(Object.entries(allData).filter(([key]) => Utils.isDailyKey(key))));
    }

    static async getSavedKeys(): Promise<Array<string>> {
        return Object.keys(await browser.storage.local.get()).filter(key => Utils.isDailyKey(key));
    }

    static async exportJSONString(mode: 'full' | 'daily'): Promise<string> {
        const response = await browser.runtime.sendMessage({ type: 'data:export', mode });
        if (!response?.ok || typeof response.json !== 'string') throw new Error(response?.error ?? 'Export was not acknowledged');
        return response.json;
    }

    // UI contexts request a background-owned transaction; they never perform the
    // destructive writes themselves. Missing background acknowledgement is failure.
    private static async requestReplacement(mode: CounterReplacementRequest['mode'], data: unknown): Promise<void> {
        const response: CounterReplacementResponse = await browser.runtime.sendMessage({ type: 'counter:replace', mode, data });
        if (response?.ok !== true) {
            throw new Error(response && 'error' in response ? response.error : 'Counter replacement was not acknowledged');
        }
    }

    static onReplacement(callback: (request: CounterReplacementRequest) => Promise<void>): void {
        browser.runtime.onMessage.addListener(message => {
            if (message?.type !== 'counter:replace') return;
            return callback(message as CounterReplacementRequest)
                .then((): CounterReplacementResponse => ({ ok: true }))
                .catch((error): CounterReplacementResponse => ({ ok: false, error: String(error?.message ?? error) }));
        });
    }

    private static normalizeDomainMaps(data: CounterData): CounterData {
        return Object.fromEntries(Object.entries(data).map(([date, day]) => [
            date, { ...day, websiteTime: copyDomainTimes(day.websiteTime) }
        ]));
    }

    static async overwriteStorage(newData: unknown): Promise<void> {
        parseTransfer(newData, 'overwrite');
        await this.requestReplacement('overwrite', newData);
    }

    static async mergeStorage(newData: unknown): Promise<void> {
        parseTransfer(newData, 'merge');
        await this.requestReplacement('merge', newData);
    }

    static async materializeTarget(mode: 'overwrite' | 'merge', incoming: CounterData): Promise<CounterData> {
        const result = mode === 'merge' ? this.normalizeDomainMaps(await this.savedData()) : {};
        for (const [key, importedDay] of Object.entries(incoming)) {
            const existing = mode === 'merge' ? result[key] : undefined;
            const websiteTime = copyDomainTimes(existing?.websiteTime ?? {});
            for (const [domain, seconds] of Object.entries(importedDay.websiteTime)) addDomainSeconds(websiteTime, domain, seconds);
            result[key] = { ...importedDay, netTime: (existing?.netTime ?? 0) + importedDay.netTime, websiteTime };
        }
        Utils.isValidCounterData(result); return result;
    }

    static async writeTarget(mode: 'overwrite' | 'merge', target: CounterData): Promise<Counter> {
        if (mode === 'overwrite') await browser.storage.local.remove(await this.getSavedKeys());
        await browser.storage.local.set(encodeDailyMap(target));
        return this.currentCounter(target);
    }

    // Only the background transaction invokes this storage phase. Revalidate at
    // the receiving context; keep the external daily JSON schema unchanged.
    static async replaceInBackground(request: CounterReplacementRequest): Promise<Counter> {
        if (request.mode !== 'overwrite' && request.mode !== 'merge') throw new Error('Invalid replacement mode');
        if (!Utils.isValidCounterData(request.data)) throw new Error('Invalid replacement data');
        const target = await this.materializeTarget(request.mode, request.data as CounterData);
        return this.writeTarget(request.mode, target);
    }

    private static currentCounter(data: CounterData): Counter {
        const current = data[Utils.getTodaysDate()];
        return current ? Counter.constructFromDailyData(current) : new Counter();
    }

    static async getSavedDates(): Promise<Array<Date>> {
        return (await this.getSavedKeys()).map((key) => new Date(key));
    }
}
