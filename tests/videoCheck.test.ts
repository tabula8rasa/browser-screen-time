// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMock, deferred, flush, settings } from './helpers/browserMock';

let mock: ReturnType<typeof createBrowserMock>;
let windowListeners: ReturnType<typeof vi.spyOn>;
function media(tag = 'video', playing = false, readyState = 4) {
    const node = document.createElement(tag) as HTMLMediaElement;
    Object.defineProperties(node, { paused: { value: !playing, writable: true }, ended: { value: false, writable: true },
        readyState: { value: readyState, writable: true }, error: { value: null, writable: true } });
    document.body.append(node); return node;
}
function play(node: HTMLMediaElement) { Object.defineProperty(node, 'paused', { value: false, writable: true }); node.dispatchEvent(new Event('playing')); }
function stop(node: HTMLMediaElement, event = 'pause') { if (event === 'pause') Object.defineProperty(node, 'paused', { value: true, writable: true }); node.dispatchEvent(new Event(event)); }
async function start() { await import('../src/scripts/videoCheck'); await flush(); mock.ports.at(-1).onMessage.emit({ type: 'media:accepted' }); await flush(); return mock.ports.at(-1); }
function messages() { return mock.ports.at(-1).messages; }
function lastFacts() { return messages().filter(m => m.type === 'media:element').at(-1).element; }
beforeEach(() => {
    vi.resetModules(); mock = createBrowserMock(); mock.data.settings = settings;
    vi.doMock('webextension-polyfill', () => ({ default: mock.browser }));
    document.body.innerHTML = ''; windowListeners = vi.spyOn(window, 'addEventListener');
});
afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    for (const [type, listener, options] of windowListeners.mock.calls) window.removeEventListener(type as string, listener as EventListener, options as any);
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function shadow(parent: ParentNode = document.body): ShadowRoot {
    const host = document.createElement('div'); parent.appendChild(host);
    return host.attachShadow({ mode: 'open' });
}

describe('open shadow DOM media', () => {
    it.each(['video', 'audio'])('initial scan finds playing %s inside an open root', async tag => {
        const root = shadow(); const node = media(tag, true); root.append(node);
        const port = await start();
        expect(port.messages.at(-1).elements).toEqual([{ elementId: '1', playing: true, muted: false, volume: 1 }]);
    });
    it('observes new media inside an already observed open root without duplicate listeners', async () => {
        const root = shadow(); await start(); const node = media('audio', true); root.append(node); await flush();
        expect(messages().filter(m => m.type === 'media:element')).toHaveLength(1);
        const before = messages().length; stop(node); expect(messages().length).toBe(before + 1);
        node.remove(); await flush(); expect(messages().at(-1).type).toBe('media:removed');
    });
    it('discovers attachShadow on an existing host even with no light-DOM mutation', async () => {
        vi.useFakeTimers();
        const host = document.createElement('div'); document.body.append(host);
        const node = media('audio', true); node.remove(); await start();
        host.attachShadow({ mode: 'open' }).append(node);
        await vi.advanceTimersByTimeAsync(1000); await flush();
        expect(lastFacts()).toMatchObject({ playing: true });
        node.remove(); await flush(); expect(messages().at(-1).type).toBe('media:removed');
    });
    it('keeps identity and buffered playback across light → shadow movement, then clears removal', async () => {
        const host = document.createElement('div'); document.body.append(host);
        const node = media('video', true); await start(); const id = messages().at(-1).elements[0].elementId;
        Object.defineProperty(node, 'readyState', { value: 2, writable: true }); node.dispatchEvent(new Event('waiting'));
        const root = host.attachShadow({ mode: 'open' }); root.append(node); await flush();
        expect(messages().filter(m => m.type === 'media:removed')).toHaveLength(0);
        node.dispatchEvent(new Event('volumechange')); expect(lastFacts()).toMatchObject({ elementId: id, playing: true });
        node.remove(); await flush(); expect(messages().at(-1)).toEqual({ type: 'media:removed', elementId: id });
        const count = messages().length; play(node); expect(messages()).toHaveLength(count);
    });
    it('recursively discovers nested roots and cleans removed host subtrees', async () => {
        const outer = shadow(); const inner = shadow(outer); const node = media('audio', true); inner.append(node);
        await start(); expect(messages().at(-1).elements[0].playing).toBe(true);
        outer.host.remove(); await flush(); expect(messages().at(-1).type).toBe('media:removed');
    });
    it('pagehide disconnects every observer/listener and discovery timer; BFCache rescans nested roots', async () => {
        vi.useFakeTimers(); const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
        const root = shadow(shadow()); const node = media('audio', true); root.append(node);
        const old = await start(); window.dispatchEvent(new Event('pagehide')); await flush();
        expect(disconnect).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
        const before = old.messages.length; play(node); root.append(document.createElement('audio')); await flush();
        expect(old.messages).toHaveLength(before);
        window.dispatchEvent(new Event('pageshow')); await flush(); const current = mock.ports.at(-1);
        current.onMessage.emit({ type: 'media:accepted' });
        expect(current.messages.at(-1).elements).toHaveLength(2);
        expect(current.messages.at(-1).elements[0].playing).toBe(true);
    });
    it('does not register media moved into a closed root', async () => {
        const host = document.createElement('div'); document.body.append(host);
        const node = media('audio', true); await start();
        host.attachShadow({ mode: 'closed' }).append(node); await flush();
        expect(messages().at(-1).type).toBe('media:removed');
    });
});

describe('HTML video/audio detector', () => {
    it.each(['video', 'audio'])('initial scan finds already-playing %s and reports mute/volume facts', async tag => {
        const node = media(tag, true); node.muted = true; node.volume = 0;
        const port = await start(); const snapshot = port.messages.find(m => m.type === 'media:snapshot');
        expect(snapshot.elements).toEqual([{ elementId: '1', playing: true, muted: true, volume: 0 }]);
        node.muted = false; node.volume = .5; node.dispatchEvent(new Event('volumechange'));
        expect(lastFacts()).toMatchObject({ playing: true, muted: false, volume: .5 });
    });
    it('play alone is insufficient, playing enables, buffering retains, explicit stops clear', async () => {
        const node = media('video', false, 0); await start();
        Object.defineProperty(node, 'paused', { value: false, writable: true }); node.dispatchEvent(new Event('play'));
        expect(messages().find(m => m.type === 'media:snapshot').elements[0].playing).toBe(false);
        play(node); expect(lastFacts().playing).toBe(true);
        const before = messages().length; node.dispatchEvent(new Event('waiting')); node.dispatchEvent(new Event('stalled'));
        expect(messages()).toHaveLength(before);
        node.dispatchEvent(new Event('volumechange')); expect(lastFacts().playing).toBe(true);
        for (const event of ['pause', 'ended', 'emptied', 'error']) { play(node); stop(node, event); expect(lastFacts().playing).toBe(false); }
    });
    it('finds later elements/subtrees, keeps same-src elements independent, handles moves/removal/reinsertion', async () => {
        await start(); const wrapper = document.createElement('div'); const a = media('audio', true); const b = media('video', true);
        a.src = b.src = 'same.mp4'; a.classList.add('bws-found'); wrapper.append(a, b); document.body.append(wrapper); await flush();
        const updates = messages().filter(m => m.type === 'media:element'); expect(updates).toHaveLength(2);
        expect(updates[0].element.elementId).not.toBe(updates[1].element.elementId);
        stop(a); expect(lastFacts().elementId).toBe(updates[0].element.elementId);
        document.body.append(b); await flush(); expect(messages().filter(m => m.type === 'media:removed')).toHaveLength(0);
        b.remove(); await flush(); expect(messages().at(-1)).toEqual({ type: 'media:removed', elementId: updates[1].element.elementId });
        const count = messages().length; play(b); expect(messages()).toHaveLength(count);
        document.body.append(b); await flush(); expect(lastFacts().playing).toBe(true);
    });
    it('disable clears only this document; re-enable immediately scans existing playback', async () => {
        media('audio', true); await start();
        mock.ports.at(-1).onMessage.emit({ type: 'media:settings', enabled: false });
        expect(messages().at(-1)).toEqual({ type: 'media:snapshot', elements: [] });
        mock.ports.at(-1).onMessage.emit({ type: 'media:settings', enabled: true });
        expect(messages().at(-1).elements[0].playing).toBe(true);
    });
    it('port settings supersede a delayed initial read and can enable a document initially disabled', async () => {
        const load = deferred<any>(); mock.browser.storage.local.get.mockReturnValueOnce(load.promise);
        media('audio', true); await import('../src/scripts/videoCheck'); await flush();
        const port = mock.ports.at(-1);
        port.onMessage.emit({ type: 'media:settings', enabled: true });
        port.onMessage.emit({ type: 'media:accepted' });
        load.resolve({ settings: { ...settings, videoCheck: false } }); await flush();
        expect(port.messages.at(-1).elements[0].playing).toBe(true);
        port.onMessage.emit({ type: 'media:settings', enabled: false });
        expect(port.messages.at(-1)).toEqual({ type: 'media:snapshot', elements: [] });
        port.onMessage.emit({ type: 'media:settings', enabled: true });
        expect(port.messages.at(-1).elements[0].playing).toBe(true);
    });
    it('pagehide disconnects; BFCache pageshow reconnects with a fresh ownership token and snapshot', async () => {
        media('video', true); const old = await start(); const oldToken = old.messages[0].token;
        window.dispatchEvent(new Event('pagehide')); await flush(); expect(old.disconnect).toHaveBeenCalledTimes(1); expect(mock.ports).toHaveLength(1);
        window.dispatchEvent(new Event('pageshow')); await flush(); const current = mock.ports.at(-1);
        expect(current).not.toBe(old); expect(current.messages[0].token).not.toBe(oldToken);
        old.onMessage.emit({ type: 'media:accepted' }); expect(current.messages).toHaveLength(1);
        current.onMessage.emit({ type: 'media:accepted' }); expect(current.messages.at(-1).elements[0].playing).toBe(true);
        const response = mock.browser.runtime.onMessage.emit({ type: 'media:current-document' });
        expect(await response.find(value => value instanceof Promise)).toEqual({ token: current.messages[0].token });
    });
    it('background disconnect reconnects and resends current factual state', async () => {
        media('audio', true); const old = await start(); old.onDisconnect.emit(); await flush();
        const current = mock.ports.at(-1); expect(current).not.toBe(old);
        current.onMessage.emit({ type: 'media:accepted' }); expect(current.messages.at(-1).elements[0].playing).toBe(true);
    });
});
