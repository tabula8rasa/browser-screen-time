import { vi } from 'vitest';

export function event() {
    const listeners = new Set<(...args: any[]) => any>();
    return {
        addListener: vi.fn((listener: (...args: any[]) => any) => listeners.add(listener)),
        removeListener: vi.fn((listener: (...args: any[]) => any) => listeners.delete(listener)),
        emit: (...args: any[]) => Array.from(listeners, listener => listener(...args))
    };
}

export function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

export async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

export class MockPort {
    name = 'browser-screen-time:media';
    onMessage = event();
    onDisconnect = event();
    messages: any[] = [];
    postMessage = vi.fn((message: any) => this.messages.push(message));
    disconnect = vi.fn(() => this.onDisconnect.emit(this));
    constructor(public sender?: any) {}
}

export function createBrowserMock() {
    const data: Record<string, any> = {};
    const activeTabs = new Map<number, any>([[1, { id: 10, windowId: 1, active: true, url: 'https://github.com/' }]]);
    const documents = new Map<string, string>();
    const ports: MockPort[] = [];
    const browser = {
        windows: {
            WINDOW_ID_NONE: -1,
            onFocusChanged: event(), onRemoved: event(),
            getAll: vi.fn(async () => [{ id: 1, focused: true }])
        },
        tabs: {
            onActivated: event(), onUpdated: event(), onRemoved: event(),
            onAttached: event(), onDetached: event(), onReplaced: event(),
            query: vi.fn(async (options: any) => activeTabs.has(options.windowId) ? [activeTabs.get(options.windowId)] : []),
            sendMessage: vi.fn(async (tabId: number, _message: any, options: any) => ({ token: documents.get(`${tabId}:${options.frameId}`) }))
        },
        idle: { onStateChanged: event(), setDetectionInterval: vi.fn(), queryState: vi.fn(async (_seconds: number) => 'active') },
        runtime: {
            id: 'test-extension', onMessage: event(), onConnect: event(),
            sendMessage: vi.fn(async (_message: any) => {}),
            getBrowserInfo: vi.fn(), getURL: vi.fn((path: string) => `moz-extension://test-extension/${path}`),
            connect: vi.fn(() => { const port = new MockPort(); ports.push(port); return port; })
        },
        action: { setIcon: vi.fn(async (_icon: any) => {}) },
        notifications: { create: vi.fn(async (_notification: any) => 'notification') },
        storage: { local: {
            get: vi.fn(async (keys?: any) => {
                if (keys === undefined) return structuredClone(data);
                const result: Record<string, any> = {};
                for (const key of typeof keys === 'string' ? [keys] : keys) if (data[key] !== undefined) result[key] = structuredClone(data[key]);
                return result;
            }),
            set: vi.fn(async (values: any) => Object.assign(data, structuredClone(values))),
            remove: vi.fn(async (keys: string[]) => { keys.forEach(key => delete data[key]); })
        } }
    };
    return { browser, data, activeTabs, documents, ports };
}

export const settings = { idleTimer: '15', videoCheck: true, notifications: false, notificationTimer: '7200' };
export const element = (elementId = '1', overrides: Record<string, unknown> = {}) =>
    ({ elementId, playing: true, muted: false, volume: 1, ...overrides });
