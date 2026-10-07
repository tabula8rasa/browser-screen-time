import browser, { Runtime } from 'webextension-polyfill';
import SettingsStorage from './settingsStorage';
import { MEDIA_PORT, MediaBackgroundMessage, MediaElementState, MediaMessage } from './types';

interface ObservedMedia {
    elementId: string;
    playing: boolean;
    listeners: Map<string, EventListener>;
}

const elements = new Map<HTMLMediaElement, ObservedMedia>();
let nextElementId = 0;
let enabled = false;
let settingsGeneration = 0;
let live = true;
let port: Runtime.Port | null = null;
let accepted = false;
let token: string | null = null;

function facts(element: HTMLMediaElement, tracked: ObservedMedia): MediaElementState {
    return {
        elementId: tracked.elementId,
        playing: tracked.playing && !element.paused && !element.ended && !element.error,
        muted: element.muted,
        volume: element.volume
    };
}

function send(message: MediaMessage): void {
    if (!port || !accepted) return;
    try { port.postMessage(message); } catch { /* A disappearing document will disconnect its port. */ }
}

function snapshot(): void {
    send({ type: 'media:snapshot', elements: Array.from(elements, ([element, tracked]) => facts(element, tracked)) });
}

function observeElement(element: HTMLMediaElement): void {
    if (elements.has(element)) return;
    const tracked: ObservedMedia = {
        elementId: String(++nextElementId),
        // A scan can find playback which started before document_idle. Do not
        // infer playback from an unbuffered play request; playing establishes it.
        playing: !element.paused && !element.ended && !element.error &&
            element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA,
        listeners: new Map()
    };
    elements.set(element, tracked);
    for (const event of ['playing', 'pause', 'ended', 'emptied', 'error', 'volumechange']) {
        const listener: EventListener = () => {
            if (event === 'playing') tracked.playing = true;
            else if (event !== 'volumechange') tracked.playing = false;
            send({ type: 'media:element', element: facts(element, tracked) });
        };
        tracked.listeners.set(event, listener);
        element.addEventListener(event, listener);
    }
    send({ type: 'media:element', element: facts(element, tracked) });
}

// MutationObserver cannot see attachShadow() on an existing host in the
// page's isolated JS world. A 1s discovery scan supplements root-local observers.
// This timer discovers DOM roots only; it never expires media playback state.
const rootObservers = new Map<Document | ShadowRoot, MutationObserver>();
let rootDiscovery: ReturnType<typeof setInterval> | null = null;

function reachable(node: Node): boolean {
    if (!node.isConnected || node.ownerDocument !== document) return false;
    let root = node.getRootNode();
    while (root instanceof ShadowRoot) {
        if (root.host.shadowRoot !== root) return false; // Closed roots are out of scope.
        root = root.host.getRootNode();
    }
    return root === document;
}

function scan(root: Document | ShadowRoot): void {
    if (!rootObservers.has(root)) {
        const observer = new MutationObserver(reconcileDOM);
        observer.observe(root, { childList: true, subtree: true });
        rootObservers.set(root, observer);
    }
    root.querySelectorAll('*').forEach(element => {
        if (element instanceof HTMLMediaElement) observeElement(element);
        if (element.shadowRoot) scan(element.shadowRoot);
    });
}

function removeElement(element: HTMLMediaElement): void {
    const tracked = elements.get(element);
    if (!tracked) return;
    tracked.listeners.forEach((listener, event) => element.removeEventListener(event, listener));
    elements.delete(element);
    send({ type: 'media:removed', elementId: tracked.elementId });
}

function reconcileDOM(): void {
    if (!live || !enabled) return;
    scan(document);
    // Inspect the final composed DOM. Moving between light/open shadow trees
    // retains element identity and established playback, including buffering.
    for (const element of elements.keys()) {
        if (!reachable(element)) removeElement(element);
    }
    for (const [root, observer] of rootObservers) {
        if (root instanceof ShadowRoot && !reachable(root.host)) {
            observer.disconnect();
            rootObservers.delete(root);
        }
    }
}

function startObserving(): void {
    reconcileDOM();
    if (rootDiscovery === null) rootDiscovery = setInterval(reconcileDOM, 1000);
}

function clearElements(): void {
    if (rootDiscovery !== null) clearInterval(rootDiscovery);
    rootDiscovery = null;
    rootObservers.forEach(observer => observer.disconnect());
    rootObservers.clear();
    for (const element of elements.keys()) removeElement(element);
}

function applySettings(next: boolean): void {
    if (enabled === next) return;
    enabled = next;
    if (live && enabled) {
        startObserving();
    } else clearElements();
    snapshot();
}

function connect(): void {
    if (!live || port) return;
    try {
        const connection = browser.runtime.connect({ name: MEDIA_PORT });
        port = connection;
        token = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-');
        accepted = false;
        connection.onMessage.addListener((message: MediaBackgroundMessage) => {
            if (port !== connection) return;
            if (message?.type === 'media:settings' && typeof message.enabled === 'boolean') {
                settingsGeneration++;
                applySettings(message.enabled);
            } else if (message?.type === 'media:accepted') {
                accepted = true;
                snapshot();
            }
        });
        connection.onDisconnect.addListener(() => {
            if (port !== connection) return;
            port = null;
            token = null;
            accepted = false;
            // Reconnect after a background restart. No periodic heartbeat or
            // silence timeout is used; pagehide prevents reconnecting old pages.
            if (live) queueMicrotask(connect);
        });
        connection.postMessage({ type: 'media:hello', token } satisfies MediaMessage);
    } catch {
        port = null;
        token = null;
        accepted = false;
    }
}

// This token only proves which connection belongs to the current frame. It is
// never used as a tab/frame/document ID; those always come from Firefox sender.
browser.runtime.onMessage.addListener((message: { type?: string }) => {
    if (message?.type === 'media:current-document' && live && token) return Promise.resolve({ token });
});

window.addEventListener('pagehide', () => {
    live = false;
    clearElements();
    const connection = port;
    port = null;
    token = null;
    accepted = false;
    connection?.disconnect();
});

window.addEventListener('pageshow', () => {
    if (live) return;
    live = true;
    if (enabled) {
        startObserving();
    }
    connect();
});

const initialSettingsGeneration = settingsGeneration;
void SettingsStorage.get().then(settings => {
    if (initialSettingsGeneration === settingsGeneration) applySettings(settings.videoCheck === true);
}).catch(error => console.warn('Media settings initialization failed', error));
connect();
