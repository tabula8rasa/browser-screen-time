import type { CounterDailyData, CounterData } from './counter';
import { copyDomainTimes } from './domainTime';
import { consistentDailyTotal } from './dailyTotals';

const reserved = new Set(Object.getOwnPropertyNames(Object.prototype));
const own = (object: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && !('value' in descriptor)) throw new Error(`Invalid daily property ${key}`);
    return descriptor?.value;
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const seconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Firefox sanitizes Object.prototype names when returning dynamic object keys.
// Tuple elements survive that boundary; canonical maps never expose this field.
export function decodeDailyData(raw: unknown): CounterDailyData {
    if (!object(raw)) throw new Error('Invalid daily data');
    const source = own(raw, 'websiteTime'), total = own(raw, 'netTime');
    if (!object(source) || !seconds(total)) throw new Error('Invalid daily totals');
    const websiteTime: Record<string, number> = {};
    for (const name of Object.keys(source)) {
        const value = own(source, name);
        if (!seconds(value)) throw new Error('Invalid daily website time');
        Object.defineProperty(websiteTime, name, { value, enumerable: true, configurable: true, writable: true });
    }
    const entries = own(raw, 'websiteTimeReserved');
    if (Object.getOwnPropertyDescriptor(raw, 'websiteTimeReserved')) {
        if (!Array.isArray(entries)) throw new Error('Invalid reserved website times');
        const seen = new Set<string>();
        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !reserved.has(entry[0]) || !seconds(entry[1]) || seen.has(entry[0])) throw new Error('Invalid/duplicate reserved website time');
            const [name, value] = entry;
            const existing = Object.getOwnPropertyDescriptor(websiteTime, name);
            if (existing && existing.value !== value) throw new Error('Conflicting reserved website time');
            Object.defineProperty(websiteTime, name, { value, enumerable: true, configurable: true, writable: true });
            seen.add(name);
        }
    }
    if (!consistentDailyTotal(total, Object.values(websiteTime))) throw new Error('Daily website time does not match netTime');
    const result: Record<string, unknown> = { ...raw, netTime: total, websiteTime };
    delete result.websiteTimeReserved;
    return result as unknown as CounterDailyData;
}

export function encodeDailyData(canonical: CounterDailyData | object): CounterDailyData & { websiteTimeReserved?: Array<[string, number]> } {
    // Regenerate the codec from the map; stale codec fields never add seconds.
    const clean = { ...canonical } as Record<string, unknown>;
    delete clean.websiteTimeReserved;
    const day = decodeDailyData(clean);
    const websiteTime = copyDomainTimes(day.websiteTime), entries: Array<[string, number]> = [];
    for (const name of Object.keys(websiteTime)) if (reserved.has(name)) { entries.push([name, websiteTime[name]]); }
    return { ...day, websiteTime, ...(entries.length ? { websiteTimeReserved: entries } : {}) };
}

export function decodeDailyMap(data: CounterData): CounterData {
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, decodeDailyData(value)]));
}
export function encodeDailyMap(data: CounterData): CounterData {
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encodeDailyData(value)]));
}
