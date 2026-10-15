// @vitest-environment jsdom
import { act } from 'react';
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dashboard from '../src/scripts/components/dashboard';
import Settings from '../src/scripts/components/settings';
import { SITE_COLOR_PREFIX, OTHER_COLOR_KEY } from '../src/scripts/siteColors';
import { assignDomainColors } from '../src/scripts/dashboardData';
const mock = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), sendMessage: vi.fn() }));
vi.mock('webextension-polyfill', () => ({ default: { storage: { local: { get: mock.get, set: mock.set } }, runtime: { sendMessage: mock.sendMessage } } }));
let element: HTMLDivElement, root: Root;
let savedTimelineSettings: Record<string, string | boolean>;
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
async function updateTimelineSetting(key: string, value: string | boolean) {
    savedTimelineSettings[key] = value;
    mock.get.mockResolvedValue({ ...snapshot, settings: savedTimelineSettings });
    await click('Refresh saved data');
}
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    savedTimelineSettings = {};
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 7, 12));
    mock.set.mockResolvedValue(undefined); mock.get.mockResolvedValue(snapshot); mock.sendMessage.mockResolvedValue(empty);
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
        expect(element.querySelector('.dashboard-heading img')?.getAttribute('src')).toBe('assets/icons/128px.png');
    });
    it('keeps five empty lanes and the day axis visible while loading and without calendar history', async () => {
        const pending = deferred<any>();
        mock.sendMessage.mockReturnValueOnce(pending.promise);
        await render();
        expect(element.querySelectorAll('.timeline-lane')).toHaveLength(5);
        expect(element.querySelectorAll('.time-axis span')).toHaveLength(13);
        expect(element.querySelector('.time-axis')?.textContent).toContain('00:00');
        expect(element.querySelector('.time-axis')?.textContent).toContain('24:00');
        await act(async () => pending.resolve(empty));
        expect(element.querySelectorAll('.timeline-lane')).toHaveLength(5);
        expect(element.querySelectorAll('.timeline-labels > div')).toHaveLength(6);
        expect(element.querySelectorAll('.session-span')).toHaveLength(0);
        expect(element.textContent).not.toContain('Partial session history:');
        expect(element.textContent).not.toContain('Visual smoothing up to');
    });
    it('toggles isolated short sessions after smoothing without changing labels or totals', async () => {
        const base = Date.UTC(2026, 9, 7);
        const group = { dayKey: '2026-10-07', timeZone: 'UTC', dayStart: base, dayEnd: base + 86400000, status: 'partial' };
        mock.sendMessage.mockResolvedValue({ status: 'partial', groups: [group], domains: [{ id: 1, domain: 'a' }], sessions: [
            { ...group, id: 1, domainId: 1, start: base, end: base + 60000 },
            { ...group, id: 2, domainId: 1, start: base + 90000, end: base + 150000 },
            { ...group, id: 3, domainId: 1, start: base + 3600000, end: base + 3660000 }
        ] });
        await render();
        const labels = element.querySelector('.timeline-labels')?.textContent;
        expect(element.querySelectorAll('.session-span')).toHaveLength(2);
        await updateTimelineSetting('timelineHideShortIsolated', true);
        expect(element.querySelectorAll('.session-span')).toHaveLength(1);
        expect(element.querySelector('[aria-pressed]')).toBeNull();
        expect(element.querySelector('.timeline-labels')?.textContent).toBe(labels);
        const zoom = element.querySelector('[aria-label="Timeline zoom"]') as HTMLSelectElement;
        await act(async () => { zoom.value = '4'; zoom.dispatchEvent(new Event('change', { bubbles: true })); });
        expect(element.querySelectorAll('.session-span')).toHaveLength(0);
        expect(element.querySelectorAll('.timeline-lane')).toHaveLength(5);
        await updateTimelineSetting('timelineHideShortIsolated', false);
        await act(async () => { zoom.value = '4'; zoom.dispatchEvent(new Event('change', { bubbles: true })); });
        expect(element.querySelectorAll('.session-span')).toHaveLength(3);
        expect(element.querySelector('.metric strong')?.textContent).toBe('1h 30m');
    });
    it('edits and persists timeline preferences in Settings and applies them on returning to the dashboard', async () => {
        let stored: Record<string, any> = { ...snapshot };
        mock.get.mockImplementation(async () => stored);
        mock.set.mockImplementation(async (value: Record<string, any>) => { stored = { ...stored, ...value }; });
        await render();
        expect(element.textContent).not.toContain('Smoothing ·');
        expect(element.textContent).not.toContain('Hide isolated sessions < 5m');
        await act(async () => { root.render(React.createElement(Settings)); });
        expect(element.querySelector('[aria-label="Timeline smoothing seconds"]')).not.toBeNull();
        await change('Timeline smoothing seconds', '120');
        await act(async () => element.querySelector<HTMLInputElement>('[name="timelineHideShortIsolated"]')!.click());
        expect(stored.settings.timelineSmoothingSeconds).toBe('120');
        expect(stored.settings.timelineHideShortIsolated).toBe(true);
        expect(stored.settings.idleTimer).toBeUndefined();
        await act(async () => { root.render(React.createElement(Settings, { key: 'reload' })); });
        expect((element.querySelector('[aria-label="Timeline smoothing seconds"]') as HTMLInputElement).value).toBe('120');
        expect(element.querySelector<HTMLInputElement>('[name="timelineHideShortIsolated"]')!.checked).toBe(true);
        await click('Reset to 800s');
        expect(stored.settings.timelineSmoothingSeconds).toBe('800');
        await render();
        expect(element.querySelector('[aria-label="Timeline smoothing seconds"]')).toBeNull();
        expect(element.textContent).not.toContain('Hide isolated sessions < 5m');
    });
    it('loads favicons only in the dashboard and falls back to letters on failure', async () => {
        await render();
        const icon = element.querySelector<HTMLImageElement>('.site-icon[src="https://example.com/favicon.ico"]')!;
        expect(icon).not.toBeNull();
        expect(icon.getAttribute('referrerpolicy')).toBe('no-referrer');
        expect(icon.parentElement?.textContent).toBe('E');
        await act(async () => icon.dispatchEvent(new Event('load')));
        expect(icon.parentElement?.textContent).toBe('');
        expect(icon.style.opacity).toBe('1');
        const parent = icon.parentElement!;
        await act(async () => icon.dispatchEvent(new Event('error')));
        expect(parent.querySelector('img')).toBeNull();
        expect(parent.textContent).toBe('E');
        await click('Refresh saved data');
        expect(parent.querySelector('img')).toBeNull();
    });
    it('does not interpret imported site labels as favicon URLs or paths', async () => {
        mock.get.mockResolvedValue({ '2026 10 7': { netTime: 60, websiteTime: { 'example.com/path': 60 } } });
        await render();
        expect(element.querySelectorAll('.site-icon')).toHaveLength(0);
        expect(element.querySelector('.site-initial')?.textContent).toBe('E');
    });
    it('uses distinct site colors consistently in bars, legends, and initials across filters', async () => {
        const domains = Array.from({ length: 30 }, (_, index) => `site-${index}.com`);
        mock.get.mockResolvedValue({ '2026 10 7': { netTime: 1800, websiteTime: Object.fromEntries(domains.map(domain => [domain, 60])) } });
        await render();
        const segments = [...element.querySelectorAll<HTMLElement>('.bar-stack > span')];
        const byDomain = new Map(segments.map(span => [span.title.split(':')[0], span.style.background]));
        expect(new Set(byDomain.values()).size).toBe(30);
        for (const site of element.querySelectorAll<HTMLElement>('.site-name')) {
            const domain = site.lastElementChild!.textContent!;
            expect((site.firstElementChild as HTMLElement).style.background).toBe(byDomain.get(domain));
        }
        for (const legend of element.querySelectorAll<HTMLElement>('.distribution li')) {
            const domain = legend.querySelector('span')!.textContent!;
            if (domain !== 'Other') expect((legend.querySelector('i') as HTMLElement).style.background).toBe(byDomain.get(domain));
        }
        await click('1D');
        for (const segment of element.querySelectorAll<HTMLElement>('.bar-stack > span')) expect(segment.style.background).toBe(byDomain.get(segment.title.split(':')[0]));
    });
    it('opens from a dot, previews HSB and hex across panels, and saves only its color preference', async () => {
        await render();
        const dot = element.querySelector<HTMLButtonElement>('[aria-label="Change color for example.com"]')!;
        const original = element.querySelector<HTMLElement>('.bar-stack > span[title^="example.com:"]')!.style.background;
        await act(async () => dot.click());
        await change('Hue value', '120'); await change('Saturation value', '100'); await change('Brightness value', '100');
        expect((element.querySelector('[aria-label="Site color hex"]') as HTMLInputElement).value).toBe('#00ff00');
        expect(element.querySelector<HTMLElement>('.bar-stack > span[title^="example.com:"]')!.style.background).toBe('rgb(0, 255, 0)');
        await change('Site color hex', '#badhex');
        expect(element.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
        await change('Site color hex', '12ABEF');
        await act(async () => element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        expect(mock.set).toHaveBeenCalledWith({ [SITE_COLOR_PREFIX + 'example.com']: '#12abef' });
        expect(element.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(dot);
        expect(element.querySelector<HTMLElement>('.bar-stack > span[title^="example.com:"]')!.style.background).not.toBe(original);
        expect(element.querySelector('.metric strong')?.textContent).toBe('1h 30m');
        mock.get.mockResolvedValue({ ...snapshot, [SITE_COLOR_PREFIX + 'example.com']: '#12abef' });
        await act(async () => root.unmount()); root = createRoot(element); await render();
        expect(element.querySelector<HTMLElement>('.bar-stack > span[title^="example.com:"]')!.style.background).toBe('rgb(18, 171, 239)');
    });
    it('opens sectors with mouse and keyboard, cancels previews, and handles save failures', async () => {
        await render();
        const sector = element.querySelector<SVGElement>('[aria-label="Change color for example.com sector"]')!;
        await act(async () => sector.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await change('Site color hex', '#00ff00'); await click('Cancel');
        expect(element.querySelector('[role="dialog"]')).toBeNull(); expect(mock.set).not.toHaveBeenCalled();
        expect(sector.getAttribute('fill')).not.toBe('#00ff00');
        await act(async () => sector.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
        expect(element.querySelector('[role="dialog"]')).not.toBeNull();
        await change('Site color hex', '#00ff00'); mock.set.mockRejectedValueOnce(new Error('Write failed'));
        await act(async () => element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        expect(element.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('Unable to save');
        await act(async () => element.querySelector('form')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        expect(element.querySelector('[role="dialog"]')).toBeNull();
    });
    it('allows changing the Other sector without treating it as a site', async () => {
        mock.get.mockResolvedValue({ '2026 10 7': { netTime: 420, websiteTime: Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(domain => [domain, 60])) } });
        await render();
        await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Change color for Other"]')!.click());
        await change('Site color hex', '#abcdef');
        await act(async () => element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        expect(mock.set).toHaveBeenCalledWith({ [OTHER_COLOR_KEY]: '#abcdef' });
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
        expect(element.querySelectorAll('.heatmap-calendar button')).toHaveLength(365);
    });
    it('lays out leap-year dates in weekday rows and week columns with month labels above', async () => {
        await render(); await change('Period end', '2024-12-31');
        const cells = element.querySelectorAll('.heatmap-calendar button');
        expect(cells).toHaveLength(366);
        expect(element.querySelectorAll('.heatmap-month-label')).toHaveLength(12);
        const january = element.querySelector('[aria-label="2024-01-01: 0s"]') as HTMLButtonElement;
        const sunday = element.querySelector('[aria-label="2024-01-07: 0s"]') as HTMLButtonElement;
        const leapDay = element.querySelector('[aria-label="2024-02-29: 0s"]') as HTMLButtonElement;
        expect(january.style.gridRow).toBe('3'); expect(january.style.gridColumn).toBe('2');
        expect(sunday.style.gridRow).toBe('2'); expect(sunday.style.gridColumn).toBe('3');
        expect(leapDay.style.gridRow).toBe('6');
        expect(january.style.background).toBe('rgb(41, 54, 75)');
        await act(async () => leapDay.click());
        expect(mock.sendMessage).toHaveBeenLastCalledWith({ type: 'history:day', dayKey: '2024-02-29' });
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
    it('uses real session durations without a calendar selector or changes to aggregate totals', async () => {
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
        expect(element.querySelector('.timeline-labels')?.textContent).toContain('session-only.com');
        expect(element.querySelector('.metric strong')?.textContent).toBe('1h 30m');
        await updateTimelineSetting('timelineSmoothingSeconds', '0');
        expect(element.querySelectorAll('.session-span')).toHaveLength(2);
        expect(element.querySelector('.timeline-caption')).toBeNull();
        expect(element.querySelector('.timeline-labels')?.textContent).toContain('session-only.com');
        await updateTimelineSetting('timelineSmoothingSeconds', '29');
        expect(element.querySelectorAll('.session-span')).toHaveLength(2);
        await updateTimelineSetting('timelineSmoothingSeconds', '30');
        expect(element.querySelectorAll('.session-span')).toHaveLength(1);
        expect(element.querySelector('.metric strong')?.textContent).toBe('1h 30m');
        await updateTimelineSetting('timelineSmoothingSeconds', '800');
        expect(element.querySelector('[aria-controls="timeline-smoothing"]')).toBeNull();
        const zoom = element.querySelector('[aria-label="Timeline zoom"]') as HTMLSelectElement;
        await act(async () => { zoom.value = '4'; zoom.dispatchEvent(new Event('change', { bubbles: true })); });
        expect(element.querySelectorAll('.session-span')).toHaveLength(2);
        expect(element.querySelector('[aria-label="Timeline calendar group"]')).toBeNull();
        expect(element.querySelector('.timeline-labels')?.textContent).toContain('session-only.com');
        expect(element.querySelector('.metric strong')?.textContent).toBe('1h 30m');
    });
    it('renders Other in one color until detailed zoom restores individual site colors', async () => {
        const base = Date.UTC(2026, 9, 7);
        const group = { dayKey: '2026-10-07', timeZone: 'UTC', dayStart: base, dayEnd: base + 86400000, status: 'available' };
        const domains = ['a', 'b', 'c', 'd', 'e', 'f'].map((domain, index) => ({ id: index + 1, domain }));
        mock.sendMessage.mockResolvedValue({ status: 'available', groups: [group], domains, sessions: domains.map((domain, index) => ({ ...group, id: index + 1, domainId: domain.id, start: base + index * 300000, end: base + index * 300000 + (index < 4 ? 180000 : 60000) })) });
        await render();
        const otherSpans = () => [...element.querySelectorAll<HTMLElement>('.timeline-lane:last-child .session-span')];
        await updateTimelineSetting('timelineSmoothingSeconds', '120');
        expect(otherSpans()).toHaveLength(2);
        expect(new Set(otherSpans().map(span => span.style.background)).size).toBe(1);
        await updateTimelineSetting('timelineSmoothingSeconds', '240');
        expect(otherSpans()).toHaveLength(1);
        expect(otherSpans()[0].title).toContain('Other:');
        for (const value of ['4', '8']) {
            const zoom = element.querySelector('[aria-label="Timeline zoom"]') as HTMLSelectElement;
            await act(async () => { zoom.value = value; zoom.dispatchEvent(new Event('change', { bubbles: true })); });
            expect(otherSpans()).toHaveLength(2);
            for (const [index, domain] of ['e', 'f'].entries()) {
                const color = document.createElement('span'); color.style.background = assignDomainColors(['a', 'b', 'c', 'd', 'e', 'f', 'example.com', 'old.com']).get(domain)!;
                expect(otherSpans()[index].style.background).toBe(color.style.background);
                expect(otherSpans()[index].title).toContain(`${domain}:`);
            }
        }
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
