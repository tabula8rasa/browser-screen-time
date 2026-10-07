import Utils from './utils'
import Counter, { CounterDailyData, CounterData } from './counter'
import { CounterOverwriteEvent, CounterReplacementRequest, CounterReplacementResponse, CounterTimespanInterval, MsgEvent } from './types'
import browser from 'webextension-polyfill'
import { isEqual, addDays, isAfter } from 'date-fns'
import { addDomainSeconds, copyDomainTimes } from './domainTime';

export default class CounterStorage {
    static async set(counter: Counter) {
        await browser.storage.local.set({ [Utils.getTodaysDate()]: counter });
    }

    static async getSingleDay(date: Date): Promise<Counter> {
        const key = Utils.formatDate(date);
        const data = (await browser.storage.local.get(key))[key];
        return data ? { ...data, websiteTime: copyDomainTimes(data.websiteTime) } : data;
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
        const allData = await browser.storage.local.get();
        if (allData.settings) {
            delete allData.settings;
        }
        return JSON.stringify(allData);
    }

    static async getSavedKeys(): Promise<Array<string>> {
        const allData = await browser.storage.local.get();
        return Object.keys(allData).filter((key) => key !== 'settings');
    }

    // UI contexts request a background-owned transaction; they never perform the
    // destructive writes themselves. Missing background acknowledgement is failure.
    private static async requestReplacement(mode: CounterReplacementRequest['mode'], data: CounterData): Promise<void> {
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
        if (!Utils.isValidCounterData(newData)) return;
        await this.requestReplacement('overwrite', this.normalizeDomainMaps(newData as CounterData));
    }

    static async mergeStorage(newData: unknown): Promise<void> {
        if (!Utils.isValidCounterData(newData)) return;
        await this.requestReplacement('merge', this.normalizeDomainMaps(newData as CounterData));
    }

    // Only the background transaction invokes this storage phase. Revalidate at
    // the receiving context; keep the external daily JSON schema unchanged.
    static async replaceInBackground(request: CounterReplacementRequest): Promise<Counter> {
        if (request.mode !== 'overwrite' && request.mode !== 'merge') throw new Error('Invalid replacement mode');
        if (!Utils.isValidCounterData(request.data)) throw new Error('Invalid replacement data');
        const newCounterData = this.normalizeDomainMaps(request.data as CounterData);
        if (request.mode === 'merge') return this.mergeInBackground(newCounterData);
        const allKeys = await this.getSavedKeys();
        await browser.storage.local.remove(allKeys);
        await browser.storage.local.set(newCounterData);
        return this.currentCounter(newCounterData);
    }

    private static async mergeInBackground(newCounterData: CounterData): Promise<Counter> {
        const allKeys = await this.getSavedKeys();
        const oldCounterData = this.normalizeDomainMaps(await browser.storage.local.get(allKeys));

        const updatedCounterData: CounterData = { ...oldCounterData };

        for (const [key, importedDay] of Object.entries(newCounterData)) {
            const existingDay = oldCounterData[key] as CounterDailyData | undefined;
            const websiteTime = copyDomainTimes(existingDay?.websiteTime ?? {});
            for (const [domain, seconds] of Object.entries(importedDay.websiteTime)) {
                addDomainSeconds(websiteTime, domain, seconds);
            }

            updatedCounterData[key] = {
                ...importedDay,
                netTime: (existingDay?.netTime ?? 0) + importedDay.netTime,
                websiteTime
            };
        }

        await browser.storage.local.set(updatedCounterData);
        return this.currentCounter(updatedCounterData);
    }

    private static currentCounter(data: CounterData): Counter {
        const current = data[Utils.getTodaysDate()];
        return current ? Counter.constructFromDailyData(current) : new Counter();
    }

    static async getSavedDates(): Promise<Array<Date>> {
        return (await this.getSavedKeys()).map((key) => new Date(key));
    }
}
