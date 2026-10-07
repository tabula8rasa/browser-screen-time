import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMock, deferred, element, flush, MockPort, settings } from './helpers/browserMock';

let mock: ReturnType<typeof createBrowserMock>;
const today = '2026 10 7';
const saved = (netTime = 0) => ({ netTime, websiteTime: { 'github.com': netTime },
    colors: ['#227C9D', '#17C3B2', '#FFCB77', '#FE6D73'], otherColor: '#CFCFCF' });
function expectSaved(key: string, minimum: number, maximum = minimum) {
    const actual = mock.data[key];
    expect(actual.netTime).toBeGreaterThanOrEqual(minimum);
    expect(actual.netTime).toBeLessThanOrEqual(maximum);
    expect(actual).toEqual(saved(actual.netTime));
}
async function start() { await import('../src/scripts/background'); await flush(); }
async function ticks(n = 1) { await vi.advanceTimersByTimeAsync(n * 1000); await flush(); }
async function media(tabId = 10, frameId = 0, documentId = 'doc', facts = element(), token = documentId) {
    const port = new MockPort({ tab: { id: tabId }, frameId, documentId });
    mock.documents.set(`${tabId}:${frameId}`, token);
    mock.browser.runtime.onConnect.emit(port);
    port.onMessage.emit({ type: 'media:hello', token }); await flush();
    expect(port.messages).toContainEqual({ type: 'media:accepted' });
    port.onMessage.emit({ type: 'media:snapshot', elements: [facts] }); await flush();
    return port;
}
function notificationsOn(timer = '1') { mock.data.settings = { ...settings, notifications: true, notificationTimer: timer }; }
function enabledIcon() { return mock.browser.action.setIcon.mock.calls.at(-1)?.[0].path[16] === 'assets/icons/16px.png'; }
async function supersededHandshake() {
    notificationsOn(); await start(); mock.browser.idle.onStateChanged.emit('idle'); await flush();
    const baseTimers = vi.getTimerCount();
    const currentValidation = deferred<any>(); const oldValidation = deferred<any>();
    mock.browser.tabs.sendMessage.mockReturnValueOnce(currentValidation.promise).mockReturnValueOnce(oldValidation.promise);
    mock.documents.set('10:0', 'current-token');
    const current = new MockPort({ tab: { id: 10 }, frameId: 0, documentId: 'current-doc' });
    const old = new MockPort({ tab: { id: 10 }, frameId: 0, documentId: 'old-doc' });
    mock.browser.runtime.onConnect.emit(current); current.onMessage.emit({ type: 'media:hello', token: 'current-token' });
    mock.browser.runtime.onConnect.emit(old); old.onMessage.emit({ type: 'media:hello', token: 'old-token' });
    oldValidation.reject(new Error('stale validation rejected')); await flush();
    old.disconnect(); currentValidation.resolve({ token: 'current-token' }); await flush();
    return { current, old, baseTimers };
}
beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 7, 12));
    mock = createBrowserMock(); mock.data.settings = settings;
    vi.doMock('webextension-polyfill', () => ({ default: mock.browser }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('focus and active-tab orchestration', () => {
    it('recovers a rejected activation lookup on the same focused tab without more user events', async () => {
        notificationsOn(); await start();
        mock.activeTabs.set(1, { id: 11, windowId: 1, active: true, url: 'https://example.org/' });
        mock.browser.tabs.query.mockRejectedValueOnce(new Error('temporary query failure'));
        mock.browser.tabs.onActivated.emit({ tabId: 11, windowId: 1 }); await flush();
        expect(enabledIcon()).toBe(false);
        expect(mock.browser.notifications.create).not.toHaveBeenCalled();
        await ticks(); expect(enabledIcon()).toBe(true);
        expect(mock.browser.notifications.create).not.toHaveBeenCalled();
        await ticks(); expect(mock.browser.notifications.create.mock.calls.at(-1)[0].message).toContain('example.org');
    });
    it('recovery is single-flight and stale results cannot win over newer focus/tab generations', async () => {
        notificationsOn(); await start(); mock.browser.tabs.query.mockRejectedValueOnce(new Error('temporary'));
        mock.browser.tabs.onActivated.emit({ tabId: 10, windowId: 1 }); await flush();
        const retry = deferred<any[]>(); mock.browser.tabs.query.mockReturnValueOnce(retry.promise);
        const before = mock.browser.tabs.query.mock.calls.length;
        await ticks(3); expect(mock.browser.tabs.query.mock.calls.length).toBe(before + 1);
        mock.browser.windows.onFocusChanged.emit(-1);
        retry.resolve([mock.activeTabs.get(1)]); await flush(); await ticks(2);
        expect(enabledIcon()).toBe(false); expect(mock.browser.notifications.create).not.toHaveBeenCalled();
        mock.browser.windows.onFocusChanged.emit(1); await flush();
        mock.browser.tabs.query.mockRejectedValueOnce(new Error('temporary'));
        mock.browser.tabs.onActivated.emit({ tabId: 10, windowId: 1 }); await flush();
        const older = deferred<any[]>(); mock.browser.tabs.query.mockReturnValueOnce(older.promise); await ticks();
        mock.activeTabs.set(1, { id: 11, windowId: 1, active: true, url: 'https://new.example/' });
        mock.browser.tabs.onActivated.emit({ tabId: 11, windowId: 1 }); await flush();
        older.resolve([{ id: 10, windowId: 1, active: true, url: 'https://github.com/' }]); await flush();
        await ticks(); expect(mock.browser.notifications.create.mock.calls.at(-1)[0].message).toContain('new.example');
    });
    it('does not require Firefox-unsupported tabs.onReplaced to initialize', async () => {
        delete (mock.browser.tabs as any).onReplaced; await start(); await ticks(); expect(enabledIcon()).toBe(true);
    });
    it('initializes from actual focused state; no focused Firefox window never counts', async () => {
        notificationsOn(); mock.browser.windows.getAll.mockResolvedValue([{ id: 1, focused: false }]);
        await start(); await ticks(16); expect(enabledIcon()).toBe(false);
        expect(mock.browser.tabs.query).not.toHaveBeenCalled(); expect(mock.browser.notifications.create).not.toHaveBeenCalled();
        expect(mock.browser.storage.local.set).not.toHaveBeenCalled();
    });
    it('focus NONE synchronously invalidates an in-flight tick; regain resolves the current tab', async () => {
        notificationsOn(); await start(); const pending = deferred<any[]>(); mock.browser.tabs.query.mockReturnValueOnce(pending.promise);
        await ticks(); mock.browser.windows.onFocusChanged.emit(-1); await flush(); expect(enabledIcon()).toBe(false);
        pending.resolve([mock.activeTabs.get(1)]); await flush(); expect(mock.browser.notifications.create).not.toHaveBeenCalled();
        mock.browser.windows.onFocusChanged.emit(1); await flush(); await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1);
    });
    it('new focus events beat delayed startup focus enumeration and older window lookups', async () => {
        const init = deferred<any[]>(); mock.browser.windows.getAll.mockReturnValueOnce(init.promise);
        notificationsOn(); await start(); mock.browser.windows.onFocusChanged.emit(-1);
        init.resolve([{ id: 1, focused: true }]); await flush(); expect(enabledIcon()).toBe(false);
        const a = deferred<any[]>(); mock.browser.tabs.query.mockReturnValueOnce(a.promise);
        mock.browser.windows.onFocusChanged.emit(1);
        mock.activeTabs.set(2, { id: 20, windowId: 2, active: true, url: 'https://mozilla.org/' });
        mock.browser.windows.onFocusChanged.emit(2); await flush(); a.resolve([mock.activeTabs.get(1)]); await flush();
        await ticks(); expect(mock.browser.notifications.create.mock.calls.at(-1)[0].message).toContain('mozilla.org');
        expect(mock.browser.tabs.query.mock.calls.every(([query]) => query.active && query.windowId !== undefined && !query.currentWindow)).toBe(true);
    });
    it('after WINDOW_ID_NONE, closing another window cannot use API state to restore focus', async () => {
        notificationsOn(); await start(); mock.browser.windows.onFocusChanged.emit(-1);
        mock.browser.windows.onRemoved.emit(999); await flush(); await ticks();
        expect(mock.browser.windows.getAll).toHaveBeenCalledTimes(1);
        expect(enabledIcon()).toBe(false); expect(mock.browser.notifications.create).not.toHaveBeenCalled();
    });
    it('a closed window cannot be restored by delayed startup enumeration', async () => {
        const initial = deferred<any[]>(); mock.browser.windows.getAll.mockReturnValueOnce(initial.promise).mockResolvedValue([]);
        notificationsOn(); await start(); mock.browser.windows.onRemoved.emit(1);
        initial.resolve([{ id: 1, focused: true }]); await flush(); await ticks();
        expect(enabledIcon()).toBe(false); expect(mock.browser.notifications.create).not.toHaveBeenCalled();
    });
    it('rapid tab activations and URL changes cannot restore stale targets', async () => {
        notificationsOn(); await start(); const old = deferred<any[]>(); mock.browser.tabs.query.mockReturnValueOnce(old.promise);
        mock.browser.tabs.onActivated.emit({ tabId: 10, windowId: 1 });
        const current = { id: 11, windowId: 1, active: true, url: 'https://mozilla.org/' }; mock.activeTabs.set(1, current);
        mock.browser.tabs.onActivated.emit({ tabId: 11, windowId: 1 }); await flush(); old.resolve([{ id: 10, windowId: 1, active: true, url: 'https://github.com/' }]); await flush();
        await ticks(); expect(mock.browser.notifications.create.mock.calls.at(-1)[0].message).toContain('mozilla.org');
        const urlLookup = deferred<any[]>(); mock.browser.tabs.query.mockReturnValueOnce(urlLookup.promise);
        mock.browser.tabs.onActivated.emit({ tabId: 11, windowId: 1 });
        mock.activeTabs.set(1, { ...current, url: 'https://example.org/' });
        mock.browser.tabs.onUpdated.emit(11, { url: 'https://example.org/' }, mock.activeTabs.get(1)); await flush();
        urlLookup.resolve([current]); await flush(); await ticks(); expect(mock.browser.notifications.create.mock.calls.at(-1)[0].message).toContain('example.org');
    });
    it('other-window activation/media do not change the focused target; closing a pending active tab invalidates its lookup', async () => {
        notificationsOn(); await start(); await media(20); mock.browser.tabs.onActivated.emit({ tabId: 20, windowId: 2 });
        await ticks(); expect(mock.browser.notifications.create.mock.calls.at(-1)[0].message).toContain('github.com');
        const old = deferred<any[]>(); mock.browser.tabs.query.mockReturnValueOnce(old.promise);
        mock.browser.tabs.onActivated.emit({ tabId: 10, windowId: 1 });
        mock.activeTabs.delete(1); mock.browser.tabs.onRemoved.emit(10, { windowId: 1 }); await flush();
        old.resolve([{ id: 10, windowId: 1, active: true, url: 'https://github.com/' }]); await flush();
        await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1); expect(enabledIcon()).toBe(false);
    });
    it.each(['about:blank', 'moz-extension://test-extension/index.html', 'bad url'])('excludes invalid/non-host/own-extension URL %s', async url => {
        notificationsOn(); mock.activeTabs.get(1).url = url; await start(); await ticks(); expect(enabledIcon()).toBe(false);
        expect(mock.browser.notifications.create).not.toHaveBeenCalled();
    });
});

describe('idle media integration and lifecycle', () => {
    it.each(['navigation', 'current disconnect'])('cancels superseded frame recovery on %s', async action => {
        const { current, old, baseTimers } = await supersededHandshake();
        expect(vi.getTimerCount()).toBe(baseTimers + 1);
        if (action === 'navigation') {
            mock.browser.tabs.onUpdated.emit(10, { status: 'loading' }, mock.activeTabs.get(1));
        } else current.disconnect();
        await flush(); expect(vi.getTimerCount()).toBe(baseTimers);
        await ticks(10);
        expect(mock.browser.tabs.sendMessage).toHaveBeenCalledTimes(2);
        expect(current.messages).not.toContainEqual({ type: 'media:accepted' });
        expect(old.messages).not.toContainEqual({ type: 'media:accepted' });
        current.onMessage.emit({ type: 'media:snapshot', elements: [element()] }); await flush();
        expect(enabledIcon()).toBe(false); expect(mock.browser.notifications.create).not.toHaveBeenCalled();
        const replacement = await media(10, 0, 'replacement'); await ticks(10);
        expect(mock.browser.tabs.sendMessage).toHaveBeenCalledTimes(3);
        expect(replacement.messages.filter(m => m.type === 'media:accepted')).toHaveLength(1);
        expect(current.messages).not.toContainEqual({ type: 'media:accepted' });
        expect(old.messages).not.toContainEqual({ type: 'media:accepted' });
    });
    it('keeps frame recovery bounded after the stale connection disconnects', async () => {
        const { current, old, baseTimers } = await supersededHandshake();
        mock.browser.tabs.sendMessage.mockRejectedValue(new Error('frame still unreachable'));
        await ticks(20);
        // Two hello validations followed by exactly three frame retries at 1/3/7s.
        expect(mock.browser.tabs.sendMessage).toHaveBeenCalledTimes(5);
        expect(vi.getTimerCount()).toBe(baseTimers);
        await ticks(20); expect(mock.browser.tabs.sendMessage).toHaveBeenCalledTimes(5);
        expect(current.disconnect).not.toHaveBeenCalled();
        expect(current.messages).not.toContainEqual({ type: 'media:accepted' });
        expect(old.messages).not.toContainEqual({ type: 'media:accepted' });
        current.onMessage.emit({ type: 'media:snapshot', elements: [element()] }); await flush();
        expect(enabledIcon()).toBe(false); expect(mock.browser.notifications.create).not.toHaveBeenCalled();
    });
    it.each(['navigation', 'current disconnect'])('rejects an in-flight frame retry result after %s and replacement', async action => {
        const { current, old, baseTimers } = await supersededHandshake();
        const retry = deferred<any>(); mock.browser.tabs.sendMessage.mockReturnValueOnce(retry.promise);
        await ticks(); expect(mock.browser.tabs.sendMessage).toHaveBeenCalledTimes(3);
        expect(current.messages).not.toContainEqual({ type: 'media:accepted' });
        if (action === 'navigation') {
            mock.browser.tabs.onUpdated.emit(10, { status: 'loading' }, mock.activeTabs.get(1));
        } else current.disconnect();
        const replacement = await media(10, 0, 'replacement');
        retry.resolve({ token: 'current-token' }); await flush(); await ticks(10);
        expect(mock.browser.tabs.sendMessage).toHaveBeenCalledTimes(4);
        expect(vi.getTimerCount()).toBe(baseTimers);
        expect(replacement.messages.filter(m => m.type === 'media:accepted')).toHaveLength(1);
        expect(current.messages).not.toContainEqual({ type: 'media:accepted' });
        expect(old.messages).not.toContainEqual({ type: 'media:accepted' });
        current.onMessage.emit({ type: 'media:snapshot', elements: [element('obsolete', { muted: true })] }); await flush();
        expect(enabledIcon()).toBe(true);
    });
    it('recovers current handshake when a rejected stale hello disconnects before current validation resolves', async () => {
        notificationsOn(); await start(); mock.browser.idle.onStateChanged.emit('idle'); await flush();
        const baseTimers = vi.getTimerCount();
        const currentValidation = deferred<any>(); const oldValidation = deferred<any>();
        mock.browser.tabs.sendMessage.mockReturnValueOnce(currentValidation.promise).mockReturnValueOnce(oldValidation.promise);
        mock.documents.set('10:0', 'current-token');
        const current = new MockPort({ tab: { id: 10 }, frameId: 0, documentId: 'current-doc' });
        mock.browser.runtime.onConnect.emit(current); current.onMessage.emit({ type: 'media:hello', token: 'current-token' });
        const old = new MockPort({ tab: { id: 10 }, frameId: 0, documentId: 'old-doc' });
        mock.browser.runtime.onConnect.emit(old); old.onMessage.emit({ type: 'media:hello', token: 'old-token' });
        expect(mock.browser.tabs.sendMessage).toHaveBeenCalledTimes(2);
        oldValidation.reject(new Error('stale validation rejected')); await flush();
        expect(vi.getTimerCount()).toBe(baseTimers + 1);
        old.disconnect(); await flush();
        currentValidation.resolve({ token: 'current-token' }); await flush();
        expect(current.disconnect).not.toHaveBeenCalled();
        expect(current.messages).not.toContainEqual({ type: 'media:accepted' });
        expect(old.messages).not.toContainEqual({ type: 'media:accepted' });
        expect(vi.getTimerCount()).toBe(baseTimers + 1); // Frame recovery survives the stale disconnect.
        current.onMessage.emit({ type: 'media:snapshot', elements: [element()] }); await flush();
        expect(enabledIcon()).toBe(false);
        await ticks(2);
        expect(mock.browser.tabs.sendMessage).toHaveBeenCalledTimes(3);
        expect(mock.browser.notifications.create).not.toHaveBeenCalled();
        expect(current.messages.filter(m => m.type === 'media:accepted')).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(baseTimers);
        expect(old.messages).not.toContainEqual({ type: 'media:accepted' });
        current.onMessage.emit({ type: 'media:snapshot', elements: [element()] }); await flush();
        expect(enabledIcon()).toBe(true); await ticks();
        expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1);
        old.onMessage.emit({ type: 'media:hello', token: 'old-token' });
        old.onMessage.emit({ type: 'media:snapshot', elements: [element('old', { muted: true })] });
        old.disconnect(); await ticks(10);
        expect(mock.browser.tabs.sendMessage).toHaveBeenCalledTimes(3);
        expect(current.messages.filter(m => m.type === 'media:accepted')).toHaveLength(1);
        expect(old.messages).not.toContainEqual({ type: 'media:accepted' });
        expect(enabledIcon()).toBe(true);
    });
    it('bounds failed handshake retries and cancels them on disconnect/navigation', async () => {
        await start(); mock.browser.tabs.sendMessage.mockRejectedValue(new Error('unreachable'));
        const make = (id: string) => {
            const port = new MockPort({ tab: { id: 10 }, frameId: 0, documentId: id });
            mock.browser.runtime.onConnect.emit(port); port.onMessage.emit({ type: 'media:hello', token: id }); return port;
        };
        const first = make('first'); await flush(); await ticks(20);
        expect(mock.browser.tabs.sendMessage).toHaveBeenCalledTimes(4);
        expect(first.messages).not.toContainEqual({ type: 'media:accepted' });
        first.disconnect(); // No other live candidate remains when closed disconnects.
        const closed = make('closed'); await flush(); closed.disconnect(); await ticks(10);
        expect(mock.browser.tabs.sendMessage).toHaveBeenCalledTimes(5);
        make('navigating'); await flush();
        mock.browser.tabs.onUpdated.emit(10, { status: 'loading' }, mock.activeTabs.get(1)); await ticks(10);
        expect(mock.browser.tabs.sendMessage).toHaveBeenCalledTimes(6);
    });
    it('an old failed handshake retry cannot replace a newer frame owner', async () => {
        await start(); mock.browser.tabs.sendMessage.mockRejectedValueOnce(new Error('transient'));
        const old = new MockPort({ tab: { id: 10 }, frameId: 0, documentId: 'old' });
        mock.browser.runtime.onConnect.emit(old); old.onMessage.emit({ type: 'media:hello', token: 'old' }); await flush();
        const current = await media(10, 0, 'current'); await ticks(5);
        expect(old.messages).not.toContainEqual({ type: 'media:accepted' });
        expect(current.messages.filter(m => m.type === 'media:accepted')).toHaveLength(1);
        expect(mock.browser.tabs.sendMessage).toHaveBeenCalledTimes(2);
    });
    it('recovers a live unaccepted port after its first current-document validation rejects', async () => {
        await start();
        mock.browser.tabs.sendMessage.mockRejectedValueOnce(new Error('transient validation failure'));
        mock.documents.set('10:0', 'live-token');
        const port = new MockPort({ tab: { id: 10 }, frameId: 0, documentId: 'live-doc' });
        mock.browser.runtime.onConnect.emit(port);
        port.onMessage.emit({ type: 'media:hello', token: 'live-token' }); await flush();
        expect(port.messages).not.toContainEqual({ type: 'media:accepted' });
        await ticks(2);
        expect(port.messages).toContainEqual({ type: 'media:accepted' });
        expect(mock.browser.tabs.sendMessage).toHaveBeenCalledTimes(2);
    });
    it('background video/audio and multiple playing tabs cannot enable idle tracking; iframe media credits parent hostname', async () => {
        notificationsOn(); await start(); mock.browser.idle.onStateChanged.emit('idle');
        await media(20); await media(30, 4); await ticks(); expect(mock.browser.notifications.create).not.toHaveBeenCalled();
        const frame = await media(10, 7); await ticks(); expect(mock.browser.notifications.create.mock.calls.at(-1)[0].message).toContain('github.com');
        frame.disconnect(); await flush(); await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1);
        mock.browser.idle.onStateChanged.emit('active'); await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(2);
    });
    it.each([{ muted: true }, { volume: 0 }])('rejects active silent media %j while idle, but ignores it while non-idle', async overrides => {
        notificationsOn(); await start(); mock.browser.idle.onStateChanged.emit('idle'); const port = await media(10, 0, 'doc', element('a', overrides));
        await ticks(); expect(mock.browser.notifications.create).not.toHaveBeenCalled();
        port.onMessage.emit({ type: 'media:element', element: element('a') }); await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1);
        port.onMessage.emit({ type: 'media:element', element: element('a', overrides) }); mock.browser.idle.onStateChanged.emit('active');
        await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(2);
    });
    it('multiple elements stop independently and disabling videoCheck immediately disables the audio/video exception', async () => {
        notificationsOn(); await start(); mock.browser.idle.onStateChanged.emit('idle'); const port = await media();
        port.onMessage.emit({ type: 'media:element', element: element('2') });
        port.onMessage.emit({ type: 'media:element', element: element('1', { playing: false }) }); await ticks();
        expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1);
        mock.browser.runtime.onMessage.emit({ type: 'settings', settings: { ...mock.data.settings, videoCheck: false } }); await ticks();
        expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1);
        mock.browser.idle.onStateChanged.emit('active'); await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(2);
    });
    it('delivers initial and live videoCheck settings only through current document ports', async () => {
        mock.data.settings = { ...settings, videoCheck: false }; await start(); const current = await media();
        expect(current.messages).toContainEqual({ type: 'media:settings', enabled: false });
        const replacement = await media(10, 0, 'replacement');
        const oldMessages = current.messages.length;
        mock.browser.runtime.onMessage.emit({ type: 'settings', settings }); await flush();
        expect(replacement.messages.at(-1)).toEqual({ type: 'media:settings', enabled: true });
        expect(current.messages).toHaveLength(oldMessages);
        mock.browser.runtime.onMessage.emit({ type: 'settings', settings: { ...settings, videoCheck: false } }); await flush();
        expect(replacement.messages.at(-1)).toEqual({ type: 'media:settings', enabled: false });
    });
    it('canceled navigation restores only the reachable surviving document with a fresh snapshot', async () => {
        notificationsOn(); await start(); mock.browser.idle.onStateChanged.emit('idle'); const current = await media();
        await ticks(); expect(enabledIcon()).toBe(true);
        mock.browser.tabs.onUpdated.emit(10, { status: 'loading' }, mock.activeTabs.get(1)); await flush();
        expect(enabledIcon()).toBe(false);
        mock.browser.tabs.onUpdated.emit(10, { status: 'complete' }, mock.activeTabs.get(1)); await flush();
        expect(current.messages.filter(message => message.type === 'media:accepted')).toHaveLength(2);
        expect(enabledIcon()).toBe(false); // Eligibility waits for the fresh resnapshot.
        current.onMessage.emit({ type: 'media:snapshot', elements: [element()] }); await flush();
        expect(enabledIcon()).toBe(true); await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(2);
        mock.browser.tabs.onUpdated.emit(10, { status: 'loading' }, mock.activeTabs.get(1));
        const pending = deferred<any>(); mock.browser.tabs.sendMessage.mockReturnValueOnce(pending.promise);
        mock.browser.tabs.onUpdated.emit(10, { status: 'complete' }, mock.activeTabs.get(1));
        mock.browser.tabs.onUpdated.emit(10, { status: 'loading' }, mock.activeTabs.get(1));
        pending.resolve({ token: 'doc' }); await flush();
        current.onMessage.emit({ type: 'media:snapshot', elements: [element()] }); await flush();
        expect(enabledIcon()).toBe(false); // A newer navigation supersedes completion validation.
    });
    it('navigation retires old documents; replacement, stale deltas/disconnects, and tab close cannot retain media', async () => {
        notificationsOn(); await start(); mock.browser.idle.onStateChanged.emit('idle'); const old = await media(); await ticks();
        mock.browser.tabs.onUpdated.emit(10, { status: 'loading' }, mock.activeTabs.get(1)); await flush();
        old.onMessage.emit({ type: 'media:snapshot', elements: [element()] }); await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1);
        const current = await media(10, 0, 'new-doc'); old.disconnect(); await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(2);
        mock.activeTabs.delete(1); mock.browser.tabs.onRemoved.emit(10, { windowId: 1 }); current.onMessage.emit({ type: 'media:element', element: element() });
        await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(2); expect(enabledIcon()).toBe(false);
    });
    it('a late old hello cannot evict the current frame owner', async () => {
        notificationsOn(); await start(); mock.browser.idle.onStateChanged.emit('idle'); const current = await media(10, 0, 'current');
        const old = new MockPort({ tab: { id: 10 }, frameId: 0, documentId: 'old' }); mock.browser.runtime.onConnect.emit(old);
        old.onMessage.emit({ type: 'media:hello', token: 'old' }); await flush();
        old.onMessage.emit({ type: 'media:snapshot', elements: [element('bad', { muted: true })] }); old.disconnect();
        await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1); expect(current.messages.filter(m => m.type === 'media:accepted')).toHaveLength(1);
    });
    it('stale async document validations cannot win over newer connections, including late old hellos', async () => {
        notificationsOn(); await start(); mock.browser.idle.onStateChanged.emit('idle');
        const lookup = deferred<any>(); mock.browser.tabs.sendMessage.mockReturnValueOnce(lookup.promise);
        const old = new MockPort({ tab: { id: 10 }, frameId: 0, documentId: 'old' }); mock.browser.runtime.onConnect.emit(old); old.onMessage.emit({ type: 'media:hello', token: 'old' });
        const current = await media(10, 0, 'current'); lookup.resolve({ token: 'old' }); await flush();
        old.onMessage.emit({ type: 'media:snapshot', elements: [element()] }); current.onMessage.emit({ type: 'media:snapshot', elements: [] }); await ticks();
        expect(mock.browser.notifications.create).not.toHaveBeenCalled();
        current.onMessage.emit({ type: 'media:element', element: element() }); await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1);
    });
    it('a late old hello during current validation resolves ownership to the current connection', async () => {
        notificationsOn(); await start(); mock.browser.idle.onStateChanged.emit('idle');
        const pending = deferred<any>(); mock.browser.tabs.sendMessage.mockReturnValueOnce(pending.promise);
        const current = new MockPort({ tab: { id: 10 }, frameId: 0, documentId: 'current' });
        mock.documents.set('10:0', 'current-token'); mock.browser.runtime.onConnect.emit(current);
        current.onMessage.emit({ type: 'media:hello', token: 'current-token' });
        const old = new MockPort({ tab: { id: 10 }, frameId: 0, documentId: 'old' }); mock.browser.runtime.onConnect.emit(old);
        old.onMessage.emit({ type: 'media:hello', token: 'old-token' }); await flush();
        expect(current.messages).toContainEqual({ type: 'media:accepted' }); expect(old.messages).toHaveLength(0);
        pending.resolve({ token: 'current-token' }); await flush();
        current.onMessage.emit({ type: 'media:snapshot', elements: [element()] }); await ticks();
        expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1);
    });
    it('media STOP and regain invalidate an in-flight tick; background updates do not invalidate it', async () => {
        notificationsOn(); await start(); mock.browser.idle.onStateChanged.emit('idle'); const current = await media();
        const pending = deferred<any[]>(); mock.browser.tabs.query.mockReturnValueOnce(pending.promise); await ticks();
        current.onMessage.emit({ type: 'media:element', element: element('1', { playing: false }) });
        current.onMessage.emit({ type: 'media:element', element: element('1') }); pending.resolve([mock.activeTabs.get(1)]); await flush();
        expect(mock.browser.notifications.create).not.toHaveBeenCalled();
        const valid = deferred<any[]>(); mock.browser.tabs.query.mockReturnValueOnce(valid.promise); await ticks();
        await media(20); valid.resolve([mock.activeTabs.get(1)]); await flush();
        expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1);
    });
    it('BFCache disconnect removes media, reconnect snapshots restore; ignores invented payload identity and invalid senders', async () => {
        notificationsOn(); await start(); mock.browser.idle.onStateChanged.emit('idle'); const old = await media(); old.disconnect(); await ticks();
        expect(mock.browser.notifications.create).not.toHaveBeenCalled();
        for (const sender of [undefined, { tab: { id: 10 }, frameId: 0 }]) {
            const bad = new MockPort(sender); mock.browser.runtime.onConnect.emit(bad);
            bad.onMessage.emit({ type: 'media:element', tabId: 10, frameId: 0, documentId: 'invented', element: element() });
        }
        const background = await media(20); background.onMessage.emit({ type: 'media:element', tabId: 10, element: element() }); await ticks();
        expect(mock.browser.notifications.create).not.toHaveBeenCalled();
        await media(10, 0, 'doc', element(), 'restored-token'); await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1);
    });
});

describe('daily accounting, notifications, and persistence', () => {
    it('handles a rejected periodic save without unhandled rejection and saves on the next cadence', async () => {
        await start(); mock.browser.storage.local.set.mockRejectedValueOnce(new Error('disk write failed'));
        await ticks(15);
        expect(console.warn).toHaveBeenCalledWith('Counter save failed', expect.any(Error));
        expect(mock.data[today]).toBeUndefined();
        await ticks(15); expectSaved(today, 29, 30);
    });
    it('import merge updates the running counter and subsequent persistence retains merged domains/history', async () => {
        mock.data[today] = saved(5);
        mock.data['2026 10 6'] = saved(7);
        await start();
        mock.browser.runtime.sendMessage.mockImplementation(async message => { mock.browser.runtime.onMessage.emit(message); });
        const { default: CounterStorage } = await import('../src/scripts/counterStorage');
        await CounterStorage.mergeStorage({ [today]: { ...saved(5), websiteTime: { 'github.com': 2, 'new.example': 3 } } });
        await ticks(15);
        expect(mock.data[today].netTime).toBeGreaterThanOrEqual(24);
        expect(mock.data[today].netTime).toBeLessThanOrEqual(25);
        expect(mock.data[today]).toEqual({ ...saved(mock.data[today].netTime), websiteTime: { 'github.com': mock.data[today].netTime - 3, 'new.example': 3 } });
        expect(mock.data['2026 10 6']).toEqual(saved(7));
        expect(mock.data.settings).toEqual(settings);
    });
    it('loads existing daily data, adds fixed seconds, saves at 15s, and keeps the notification contract', async () => {
        mock.data[today] = saved(5); notificationsOn('6'); await start();
        await ticks(); expect(mock.browser.storage.local.set).not.toHaveBeenCalled();
        expect(mock.browser.notifications.create.mock.calls[0][0]).toEqual({ type: 'basic', iconUrl: 'moz-extension://test-extension/assets/icons/256px.png',
            title: 'Browser screen time', message: 'You have already spent 6s on github.com!' });
        // The save and async tick share a deadline; either ordering is valid.
        // Different fake-timer versions also schedule those microtasks differently.
        await ticks(14); expectSaved(today, 19, 20); expect(mock.browser.storage.local.set).toHaveBeenCalledTimes(1);
        const { default: CounterStorage } = await import('../src/scripts/counterStorage');
        const loaded = await CounterStorage.get(); expect(loaded.netTime).toBe(mock.data[today].netTime); expect(loaded.websiteTime).toEqual(mock.data[today].websiteTime);
        expect(JSON.parse(await CounterStorage.getAllJSONString())).toEqual({ [today]: mock.data[today] });
    });
    it('notifications remain disabled by default; STOP preserves saved data and persistence gate', async () => {
        mock.data[today] = saved(5); await start(); await ticks(15); expectSaved(today, 19, 20);
        const persisted = structuredClone(mock.data[today]);
        expect(mock.browser.notifications.create).not.toHaveBeenCalled(); mock.browser.windows.onFocusChanged.emit(-1); await ticks(15);
        expect(mock.data[today]).toEqual(persisted); expect(mock.browser.storage.local.set).toHaveBeenCalledTimes(1);
    });
    it('slow ticks are single-flight, never backfilled, and failures release the guard', async () => {
        notificationsOn(); await start(); const query = deferred<any[]>(); mock.browser.tabs.query.mockReturnValueOnce(query.promise);
        const before = mock.browser.tabs.query.mock.calls.length; await ticks(4); expect(mock.browser.tabs.query.mock.calls.length - before).toBe(1);
        query.resolve([mock.activeTabs.get(1)]); await flush(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1);
        mock.browser.tabs.query.mockRejectedValueOnce(new Error('tab closed')); await ticks(); await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(2);
    });
    it('counter overwrite during a tick cannot be replaced by stale work', async () => {
        notificationsOn('1'); await start(); const query = deferred<any[]>(); mock.browser.tabs.query.mockReturnValueOnce(query.promise);
        await ticks(); mock.browser.runtime.onMessage.emit({ type: 'counter', counter: saved(100) }); query.resolve([mock.activeTabs.get(1)]); await flush();
        expect(mock.browser.notifications.create).not.toHaveBeenCalled(); await ticks(14); expectSaved(today, 113, 114);
    });
    it('rollover load is guarded against STOP and overwrite; preserves the existing rollover skip', async () => {
        notificationsOn(); await start(); vi.setSystemTime(new Date(2026, 9, 8, 12));
        const load = deferred<any>(); mock.browser.storage.local.get.mockReturnValueOnce(load.promise); await ticks();
        mock.browser.runtime.onMessage.emit({ type: 'counter', counter: saved(40) }); mock.browser.windows.onFocusChanged.emit(-1);
        load.resolve({ '2026 10 8': saved(1) }); await flush();
        mock.browser.windows.onFocusChanged.emit(1); await flush(); await ticks(14);
        expectSaved('2026 10 8', 53, 54);
    });
    it('a counter overwrite beats a delayed startup counter load', async () => {
        const initial = deferred<any>(); const original = mock.browser.storage.local.get.getMockImplementation();
        mock.browser.storage.local.get.mockImplementation(keys => keys === today ? initial.promise : original(keys));
        notificationsOn(); await start(); mock.browser.runtime.onMessage.emit({ type: 'counter', counter: saved(100) });
        initial.resolve({ [today]: saved(1) }); await flush(); await ticks(15);
        expectSaved(today, 114, 115);
    });
    it('a settings change during startup cannot be overwritten by stale initial settings', async () => {
        const load = deferred<any>(); mock.browser.storage.local.get.mockReturnValueOnce(load.promise).mockReturnValueOnce(load.promise);
        await start(); mock.browser.runtime.onMessage.emit({ type: 'settings', settings: { ...settings, notifications: true, notificationTimer: '1', videoCheck: false } });
        load.resolve({ settings }); await flush(); await ticks(); expect(mock.browser.notifications.create).toHaveBeenCalledTimes(1);
    });
});
