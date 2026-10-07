import { WebsiteMap } from './types';

// Keep ordinary JSON objects, but never read inherited values or invoke inherited
// setters (notably __proto__). This also works after storage/JSON rehydration.
export function domainSeconds(map: WebsiteMap, domain: string): number {
    const descriptor = Object.getOwnPropertyDescriptor(map, domain);
    return descriptor && typeof descriptor.value === 'number' ? descriptor.value : 0;
}

export function addDomainSeconds(map: WebsiteMap, domain: string, seconds: number): number {
    const total = domainSeconds(map, domain) + seconds;
    Object.defineProperty(map, domain, {
        value: total, enumerable: true, writable: true, configurable: true
    });
    return total;
}

export function copyDomainTimes(source: WebsiteMap): WebsiteMap {
    const result: WebsiteMap = {};
    for (const domain of Object.keys(source)) {
        addDomainSeconds(result, domain, domainSeconds(source, domain));
    }
    return result;
}
