// @vitest-environment jsdom
import { act } from 'react';
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dashboard from '../src/scripts/components/dashboard';
const mock = vi.hoisted(() => ({ get: vi.fn(), sendMessage: vi.fn() }));
vi.mock('webextension-polyfill', () => ({ default: { storage: { local: { get: mock.get } }, runtime: { sendMessage: mock.sendMessage } } }));
let element: HTMLDivElement, root: Root;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const empty = { status: 'unavailable', sessions: [], domains: [], groups: [] };
const snapshot = {
    '2026 10 7': { netTime: 3600, websiteTime: { 'example.com': 3600 } },
    '2026 10 6': { netTime: 1800, websiteTime: { 'old.com': 1800 } }
};
async function render() { await act(async () => { root.render(React.createElement(Dashboard)); }); }
async function change(label: string, value: string) {
    const input = element.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    });
}
async function click(text: string) {
    const button = [...element.querySelectorAll('button')].find(item => item.textContent === text)!;
    await act(async () => { button.click(); });
}
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 7, 12));
    mock.get.mockResolvedValue(snapshot); mock.sendMessage.mockResolvedValue(empty);
    element = document.createElement('div'); document.body.appendChild(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.useRealTimers(); vi.resetAllMocks(); });
describe('dashboard rendering and independent controls', () => {
    it('renders all eight sections for legacy aggregates and never invents a timeline', async () => {
        await render();
        for (const title of ['Total screen time', 'Most used site', 'Daily average', 'Total screen time by day', 'Time distribution', 'Day timeline', 'Changes vs previous period', 'Year heatmap']) expect(element.textContent).toContain(title);
        expect(element.textContent).toContain('1h 30m'); expect(element.textContent).toContain('Detailed history is unavailable');
        expect(element.textContent).toContain('Legacy daily totals cannot reconstruct a timeline');
        expect(element.querySelectorAll('.session-span')).toHaveLength(0);
        expect(element.querySelectorAll('img')).toHaveLength(1); expect(element.querySelector('img')?.getAttribute('src')).toBe('assets/icons/128px.png');
    });
    it('switches presets to exact ranges and site filtering leaves total metrics intact', async () => {
        await render(); await click('1D');
        expect((element.querySelector('[aria-label="Period start"]') as HTMLInputElement).value).toBe('2026-10-07');
        expect(element.querySelector('.metric strong')?.textContent).toBe('1h 0m');
        await click('Clear selection');
        expect(element.querySelector('.metric strong')?.textContent).toBe('1h 0m'); expect(element.querySelector('.chart-with-summary aside strong')?.textContent).toBe('0s');
        await click('30D'); expect((element.querySelector('[aria-label="Period start"]') as HTMLInputElement).value).toBe('2026-09-08');
    });
    it('keeps century-wide custom periods usable with exact total and all paginated days accessible', async () => {
        await render(); await change('Period start', '1500-01-01');
        expect(element.querySelector('.metric strong')?.textContent).toBe('1h 30m');
        expect(element.querySelectorAll('.day-bar')).toHaveLength(30); expect(element.textContent).toContain('vs previous 192398 days');
        expect(element.querySelector('.chart-pagination')?.textContent).toContain('1500-01-01 – 1500-01-30');
        await click('Next 30 days →'); expect(element.querySelector('.chart-pagination')?.textContent).toContain('1500-01-31 – 1500-03-01');
        await change('Daily chart page', String(Math.ceil(192398 / 30)));
        expect(element.querySelectorAll('.day-bar')).toHaveLength(8); expect(element.querySelector('.chart-pagination')?.textContent).toContain('2026-10-07');
        expect(element.querySelector('.metric strong')?.textContent).toBe('1h 30m');
        const last = [...element.querySelectorAll<HTMLButtonElement>('.day-bar')].at(-1)!;
        await act(async () => last.click()); expect(mock.sendMessage).toHaveBeenLastCalledWith({ type: 'history:day', dayKey: '2026-10-07' });
    });
    it('padded legacy date keys and aliases agree across totals, daily bars and heatmap', async () => {
        mock.get.mockResolvedValue({ '2026 01 07': { netTime: 60, websiteTime: { site: 60 } }, '2026 1 7': { netTime: 120, websiteTime: { site: 120 } } });
        await render(); await change('Period end', '2026-01-07'); await click('1D');
        expect(element.querySelector('.metric strong')?.textContent).toBe('3m');
        expect(element.querySelector('.day-bar')?.getAttribute('title')).toContain('3m');
        expect(element.querySelector('[aria-label="2026-01-07: 3m"]')).not.toBeNull();
        mock.get.mockResolvedValue({ '2026 01 07': { netTime: 60, websiteTime: { site: 60 } } });
        await click('Refresh saved data');
        expect(element.querySelector('.metric strong')?.textContent).toBe('1m');
        expect(element.querySelector('.day-bar')?.getAttribute('title')).toContain('1m');
        expect(element.querySelector('[aria-label="2026-01-07: 1m"]')).not.toBeNull();
    });
    it('renders actual year 0099 heatmap cells and reads its saved values', async () => {
        mock.get.mockResolvedValue({ '0099 1 1': { netTime: 60, websiteTime: { ancient: 60 } } });
        await render(); await change('Period start', '0099-01-01'); await change('Period end', '0099-12-31');
        expect(element.querySelector('.heatmap h2')?.textContent).toBe('Year heatmap · 99');
        expect(element.querySelector('[aria-label="0099-01-01: 1m"]')).not.toBeNull();
        expect(element.querySelector('[aria-label^="1999-"]')).toBeNull();
        expect(element.querySelectorAll('.heatmap-month button:not(:disabled)')).toHaveLength(365);
    });
    it('warns about corrupt persisted aggregates without rendering infinite percentages', async () => {
        mock.get.mockResolvedValue({ '2026 10 7': { netTime: 0, websiteTime: { corrupt: 10 } } });
        await render(); expect(element.querySelector('[role="alert"]')?.textContent).toContain('invalid saved daily record');
        expect(element.textContent).not.toContain('Infinity'); expect(element.textContent).not.toContain('NaN');
    });
    it('drops stale session responses when the selected day changes', async () => {
        const first = deferred<any>(), second = deferred<any>();
        mock.sendMessage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        await render(); await change('Timeline day', '2026-10-06');
        expect(mock.sendMessage).toHaveBeenLastCalledWith({ type: 'history:day', dayKey: '2026-10-06' });
        await act(async () => { second.resolve({ ...empty, error: 'Newest day' }); });
        expect(element.textContent).toContain('Newest day');
        await act(async () => { first.resolve({ ...empty, error: 'Stale day' }); });
        expect(element.textContent).not.toContain('Stale day'); expect(element.textContent).toContain('Newest day');
    });
    it('uses real session durations and switches travel groups without moving aggregate totals', async () => {
        const base = Date.UTC(2026, 9, 7);
        const utc = { dayKey: '2026-10-07', timeZone: 'UTC', dayStart: base, dayEnd: base + 86400000, status: 'partial' };
        const travel = { ...utc, timeZone: 'Asia/Tbilisi', dayStart: base - 14400000, dayEnd: base + 72000000 };
        mock.sendMessage.mockResolvedValue({ status: 'partial', domains: [{ id: 1, domain: 'session-only.com' }, { id: 2, domain: 'travel.com' }], groups: [utc, travel], sessions: [
            { ...utc, id: 1, domainId: 1, start: base, end: base + 60000 },
            { ...utc, id: 2, domainId: 1, start: base + 90000, end: base + 150000 },
            { ...travel, id: 3, domainId: 2, start: base + 160000, end: base + 220000 }
        ] });
        await render();
        expect(element.querySelectorAll('.session-span')).toHaveLength(1);
        expect(element.querySelector('.timeline-labels')?.textContent).toContain('session-only.com2m');
        expect(element.querySelector('.metric strong')?.textContent).toBe('1h 30m');
        const zoom = element.querySelector('[aria-label="Timeline zoom"]') as HTMLSelectElement;
        await act(async () => { zoom.value = '4'; zoom.dispatchEvent(new Event('change', { bubbles: true })); });
        expect(element.querySelectorAll('.session-span')).toHaveLength(2);
        const calendar = element.querySelector('[aria-label="Timeline calendar group"]') as HTMLSelectElement;
        await act(async () => { calendar.value = '1'; calendar.dispatchEvent(new Event('change', { bubbles: true })); });
        expect(element.querySelector('.timeline-labels')?.textContent).toContain('travel.com');
        expect(element.querySelector('.timeline-labels')?.textContent).not.toContain('session-only.com');
        expect(element.querySelector('.metric strong')?.textContent).toBe('1h 30m');
    });
    it('heatmap absent prototype-like sites are zero rather than inherited values', async () => {
        mock.get.mockResolvedValue({ ...snapshot, '2026 10 5': { netTime: 10, websiteTime: JSON.parse('{"constructor":10}') } });
        await render();
        const select = element.querySelector('[aria-label="Heatmap website"]') as HTMLSelectElement;
        await act(async () => { select.value = 'constructor'; select.dispatchEvent(new Event('change', { bubbles: true })); });
        expect(element.querySelector('[aria-label="2026-10-07: 0s"]')).not.toBeNull();
        expect(element.textContent).not.toContain('NaN');
    });
    it('reports aggregate read failures while preserving functioning controls', async () => {
        mock.get.mockRejectedValue(new Error('Storage denied')); await render();
        expect(element.querySelector('[role="alert"]')?.textContent).toContain('Storage denied');
        await click('1D'); expect(element.querySelector('.metric strong')?.textContent).toBe('0s');
    });
    it('distinguishes observed zero session activity from unavailable detail', async () => {
        const dayStart = new Date(2026, 9, 6).getTime(), dayEnd = new Date(2026, 9, 7).getTime();
        mock.sendMessage.mockResolvedValue({ status: 'available', sessions: [], domains: [], groups: [{ dayKey: '2026-10-06', timeZone: 'UTC', dayStart, dayEnd, status: 'available' }] });
        await render(); expect(element.textContent).toContain('No recorded activity in this observed day.');
        expect(element.textContent).not.toContain('Detailed history is unavailable');
    });
});
