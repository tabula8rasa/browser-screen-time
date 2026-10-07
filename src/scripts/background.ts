import browser, { Runtime, Tabs } from 'webextension-polyfill';
import CounterStorage from './counterStorage';
import SettingsStorage from './settingsStorage';
import Awake from './awake';
import Counter, { CounterDailyData } from './counter';
import Utils from './utils';
import { ActiveTrackingTab, MEDIA_PORT, MediaDocumentIdentity, SettingsData, TrackingState } from './types';
import { MediaRegistry, trackingTab } from './trackingState';

const saveIntervalTime = 15000;
const extensionUUID = Utils.getExtensionUUID();
// Firefox 153+ supplies documentId; strict_min_version enforces this requirement.
// The installed polyfill typings omit it.
type DocumentSender = Runtime.MessageSender & { documentId?: string };
interface Connection {
    port: Runtime.Port;
    identity: MediaDocumentIdentity;
    closed: boolean;
    retired: boolean;
    validating: boolean;
    token?: string;
}
interface TabLifecycle {
    generation: number;
    frameGenerations: Map<number, number>;
    connections: Set<Connection>;
    validationRetries: Map<number, { timer: ReturnType<typeof setTimeout>; allowRetired: boolean }>;
}

function validTab(tab: Tabs.Tab | undefined, windowId: number): ActiveTrackingTab | null {
    if (!tab || !Number.isInteger(tab.id) || tab.id < 0 || tab.windowId !== windowId || !tab.active || !tab.url) return null;
    try {
        const url = new URL(tab.url);
        if (!url.hostname || url.hostname === extensionUUID) return null;
    } catch { return null; }
    return { id: tab.id, windowId, url: tab.url };
}

async function main(): Promise<void> {
    const state: TrackingState = {
        focusedWindowId: null, activeTab: null, idle: true,
        idleInitialized: false, mediaEnabled: false
    };
    const media = new MediaRegistry();
    const lifecycles = new Map<number, TabLifecycle>();
    let focusGeneration = 0;
    let focusInitialized = false;
    let tabGeneration = 0;
    let pendingTabRequest: number | null = null;
    let activeRecoveryNeeded = false;
    let trackingGeneration = 0;
    let counterGeneration = 0;
    let settingsGeneration = 0;
    let counter: Counter | null = null;
    let currentTime = new Date();
    let settings: SettingsData | null = null;
    let tickInFlight = false;
    let effectiveTab: ActiveTrackingTab | null = null;
    let iconEnabled: boolean | null = null;
    let iconWork = Promise.resolve();

    function recalculate(): void {
        const next = trackingTab(state, media);
        if (next?.id !== effectiveTab?.id || next?.url !== effectiveTab?.url ||
            next?.windowId !== effectiveTab?.windowId) trackingGeneration++;
        effectiveTab = next;
        const enabled = next !== null;
        if (iconEnabled === enabled) return;
        iconEnabled = enabled;
        // Serialize requests: a slow enabled write must not win over a later STOP.
        iconWork = iconWork.then(async () => {
            const path: Record<number, string> = {};
            for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
                path[size] = `assets/icons/${enabled ? '' : 'disabled/'}${size}px.png`;
            }
            await browser.action.setIcon({ path });
        }).catch(error => console.warn('Tracking icon update failed', error));
    }

    async function resolveActiveTab(): Promise<void> {
        const windowId = state.focusedWindowId;
        if (windowId === null) return;
        const focus = focusGeneration;
        const request = ++tabGeneration;
        pendingTabRequest = request;
        try {
            const tabs = await browser.tabs.query({ windowId, active: true });
            if (focus !== focusGeneration || request !== tabGeneration || state.focusedWindowId !== windowId) return;
            state.activeTab = validTab(tabs[0], windowId);
            activeRecoveryNeeded = false;
            recalculate();
        } catch (error) {
            if (focus === focusGeneration && request === tabGeneration) {
                state.activeTab = null;
                activeRecoveryNeeded = true;
                recalculate();
            }
            console.warn('Active tab lookup failed', error);
        } finally {
            if (pendingTabRequest === request) pendingTabRequest = null;
        }
    }

    function invalidateActive(): void {
        tabGeneration++;
        trackingGeneration++;
        state.activeTab = null;
        activeRecoveryNeeded = true;
        recalculate();
    }

    function focusChanged(windowId: number): void {
        focusInitialized = true;
        focusGeneration++;
        state.focusedWindowId = windowId === browser.windows.WINDOW_ID_NONE || windowId < 0 ? null : windowId;
        invalidateActive(); // Synchronous STOP, before any lookup.
        void resolveActiveTab();
    }

    function initializeFocus(): void {
        const generation = focusGeneration;
        void browser.windows.getAll().then(windows => {
            if (generation !== focusGeneration) return;
            focusChanged(windows.find(window => window.focused)?.id ?? browser.windows.WINDOW_ID_NONE);
        }).catch(error => console.warn('Focus initialization failed', error));
    }

    function invalidateDocuments(tabId: number, close = false): void {
        const lifecycle = lifecycles.get(tabId);
        if (lifecycle) {
            lifecycle.generation++;
            lifecycle.validationRetries.forEach(retry => clearTimeout(retry.timer));
            lifecycle.validationRetries.clear();
            for (const connection of lifecycle.connections) {
                connection.retired = true;
                if (close) connection.port.disconnect();
            }
            if (close) lifecycles.delete(tabId);
        }
        media.removeTab(tabId);
        recalculate();
    }

    function sendMediaSettings(connection: Connection): void {
        if (connection.closed || connection.retired || !media.owns(connection.identity, connection)) return;
        try {
            connection.port.postMessage({ type: 'media:settings', enabled: state.mediaEnabled });
        } catch (error) {
            console.warn('Media settings delivery failed', error);
        }
    }

    function hasUnacceptedConnection(lifecycle: TabLifecycle, frameId: number, allowRetired = false): boolean {
        return Array.from(lifecycle.connections).some(candidate =>
            !candidate.closed && (allowRetired || !candidate.retired) && candidate.token &&
            candidate.identity.frameId === frameId && !media.owns(candidate.identity, candidate));
    }

    function validateDocument(lifecycle: TabLifecycle, tabId: number, frameId: number, allowRetired = false, attempt = 0): Promise<void> {
        clearTimeout(lifecycle.validationRetries.get(frameId)?.timer);
        lifecycle.validationRetries.delete(frameId);
        const generation = lifecycle.generation;
        const request = (lifecycle.frameGenerations.get(frameId) ?? 0) + 1;
        lifecycle.frameGenerations.set(frameId, request);
        // Resolve the reachable frame token to a Firefox sender-identified port.
        // This also restores a surviving document after canceled navigation.
        return browser.tabs.sendMessage(tabId, { type: 'media:current-document' }, { frameId })
            .then(response => {
                if (generation !== lifecycle.generation ||
                    request !== lifecycle.frameGenerations.get(frameId) ||
                    typeof response?.token !== 'string') return;
                const current = Array.from(lifecycle.connections).find(candidate =>
                    !candidate.closed && (allowRetired || !candidate.retired) &&
                    candidate.identity.frameId === frameId && candidate.token === response.token);
                if (!current || media.owns(current.identity, current)) return;
                current.retired = false;
                media.register(current.identity, current);
                recalculate();
                sendMediaSettings(current);
                current.port.postMessage({ type: 'media:accepted' });
            }).catch(error => {
                console.warn('Media document validation failed', error);
                // Retry only a failed validation, at most three times (1/2/4s).
                // This is not a media inactivity timeout or a heartbeat.
                if (attempt >= 3 || generation !== lifecycle.generation ||
                    request !== lifecycle.frameGenerations.get(frameId)) return;
                // Recovery belongs to the frame's live candidates, not to the
                // port whose hello superseded an older validation request.
                const unaccepted = () => hasUnacceptedConnection(lifecycle, frameId, allowRetired);
                if (!unaccepted()) return;
                const timer = setTimeout(() => {
                    lifecycle.validationRetries.delete(frameId);
                    if (lifecycles.get(tabId) !== lifecycle || generation !== lifecycle.generation ||
                        request !== lifecycle.frameGenerations.get(frameId) || !unaccepted()) return;
                    void validateDocument(lifecycle, tabId, frameId, allowRetired, attempt + 1);
                }, 1000 * 2 ** attempt);
                lifecycle.validationRetries.set(frameId, { timer, allowRetired });
            });
    }

    function connectMedia(port: Runtime.Port): void {
        if (port.name !== MEDIA_PORT) return;
        const sender = port.sender as DocumentSender | undefined;
        if (!Number.isInteger(sender?.tab?.id) || sender.tab.id < 0 ||
            !Number.isInteger(sender.frameId) || sender.frameId < 0 ||
            typeof sender.documentId !== 'string' || !sender.documentId) {
            console.warn('Media connection missing Firefox tab/frame/document identity');
            return;
        }
        const identity: MediaDocumentIdentity = {
            tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId
        };
        let lifecycle = lifecycles.get(identity.tabId);
        if (!lifecycle) {
            lifecycle = { generation: 0, frameGenerations: new Map(), connections: new Set(), validationRetries: new Map() };
            lifecycles.set(identity.tabId, lifecycle);
        }
        const connection: Connection = { port, identity, closed: false, retired: false, validating: false };
        lifecycle.connections.add(connection);
        port.onDisconnect.addListener(() => {
            connection.closed = true;
            lifecycle.connections.delete(connection);
            const retry = lifecycle.validationRetries.get(identity.frameId);
            // A stale port must not cancel recovery for another live candidate.
            // Cancel only when this frame has no remaining eligible candidate.
            if (retry && !hasUnacceptedConnection(lifecycle, identity.frameId, retry.allowRetired)) {
                clearTimeout(lifecycle.validationRetries.get(identity.frameId)?.timer);
                lifecycle.validationRetries.delete(identity.frameId);
            }
            media.disconnect(identity, connection);
            if (!lifecycle.connections.size && lifecycles.get(identity.tabId) === lifecycle) lifecycles.delete(identity.tabId);
            recalculate();
        });
        port.onMessage.addListener((message: unknown) => {
            if (connection.closed || connection.retired || !message || typeof message !== 'object') return;
            const value = message as Record<string, unknown>;
            if (value.type === 'media:hello') {
                if (connection.validating || media.owns(identity, connection) || typeof value.token !== 'string') return;
                connection.validating = true;
                connection.token = value.token;
                void validateDocument(lifecycle, identity.tabId, identity.frameId)
                    .finally(() => { connection.validating = false; });
                return;
            }
            if (value.type === 'media:snapshot') media.snapshot(identity, connection, value.elements);
            else if (value.type === 'media:element') media.update(identity, connection, value.element);
            else if (value.type === 'media:removed') media.removeElement(identity, connection, value.elementId);
            recalculate();
        });
    }

    // Install all listeners before settings, counter, focus, or idle awaits.
    browser.windows.onFocusChanged.addListener(focusChanged);
    browser.windows.onRemoved.addListener(windowId => {
        if (windowId === state.focusedWindowId) focusChanged(browser.windows.WINDOW_ID_NONE);
        else if (!focusInitialized) {
            focusGeneration++;
            initializeFocus(); // A removed window also invalidates startup enumeration.
        }
    });
    browser.tabs.onActivated.addListener(info => {
        if (info.windowId !== state.focusedWindowId) return;
        invalidateActive();
        void resolveActiveTab();
    });
    browser.tabs.onUpdated.addListener((tabId, changes, tab) => {
        if (changes.status === 'loading') invalidateDocuments(tabId);
        if (changes.status === 'complete') {
            const lifecycle = lifecycles.get(tabId);
            if (lifecycle) {
                const frames = new Set(Array.from(lifecycle.connections)
                    .filter(connection => !connection.closed && connection.retired)
                    .map(connection => connection.identity.frameId));
                for (const frameId of frames) void validateDocument(lifecycle, tabId, frameId, true);
            }
        }
        if ((state.activeTab?.id === tabId || (!state.activeTab && tab.active && tab.windowId === state.focusedWindowId)) &&
            (changes.url !== undefined || changes.status === 'loading')) {
            invalidateActive();
            void resolveActiveTab();
        }
    });
    function tabRemoved(tabId: number): void {
        invalidateDocuments(tabId, true);
        if (state.activeTab?.id === tabId || (!state.activeTab && state.focusedWindowId !== null)) {
            invalidateActive();
            void resolveActiveTab();
        }
    }
    browser.tabs.onRemoved.addListener(tabRemoved);
    // Firefox does not implement onReplaced; it is optional on other browsers.
    browser.tabs.onReplaced?.addListener((_addedTabId, removedTabId) => tabRemoved(removedTabId));
    browser.tabs.onDetached.addListener((tabId, info) => {
        if (info.oldWindowId === state.focusedWindowId || state.activeTab?.id === tabId) {
            invalidateActive();
            void resolveActiveTab();
        }
    });
    browser.tabs.onAttached.addListener((_tabId, info) => {
        if (info.newWindowId === state.focusedWindowId) {
            invalidateActive();
            void resolveActiveTab();
        }
    });
    browser.runtime.onConnect.addListener(connectMedia);
    const awake = new Awake(() => {
        state.idle = awake.idle;
        state.idleInitialized = awake.initialized;
        recalculate();
    });
    function applySettings(next: SettingsData): void {
        settings = next;
        state.mediaEnabled = next.videoCheck === true;
        recalculate();
        // runtime.sendMessage from the popup does not reach content scripts.
        // Their accepted document ports carry both initial and live settings.
        for (const lifecycle of lifecycles.values()) {
            for (const connection of lifecycle.connections) sendMediaSettings(connection);
        }
    }
    SettingsStorage.onChange((next: SettingsData) => {
        settingsGeneration++;
        applySettings(next);
    });
    CounterStorage.onOverwrite((data: CounterDailyData | null) => {
        counterGeneration++;
        counter = data ? Counter.constructFromDailyData(data) : new Counter();
        currentTime = new Date();
    });
    recalculate();
    initializeFocus();
    const initialSettings = settingsGeneration;
    const initialCounter = counterGeneration;
    await Promise.all([
        SettingsStorage.get().then(next => { if (initialSettings === settingsGeneration) applySettings(next); }),
        CounterStorage.get().then(next => { if (initialCounter === counterGeneration) counter = next; })
    ]);

    async function iterateCounter(): Promise<void> {
        // A failed activation lookup must recover without another user event.
        // Reuse the 1s cadence; never overlap the current generation's lookup.
        if (activeRecoveryNeeded && state.focusedWindowId !== null && pendingTabRequest !== tabGeneration) {
            await resolveActiveTab();
            return; // Unknown attribution never earns a tick during recovery.
        }
        if (tickInFlight || !effectiveTab || !counter || !settings) return;
        tickInFlight = true;
        const target = effectiveTab;
        const generation = trackingGeneration;
        const countGeneration = counterGeneration;
        const focus = focusGeneration;
        const tabRequest = tabGeneration;
        const stillCurrent = () => generation === trackingGeneration && countGeneration === counterGeneration &&
            focus === focusGeneration && tabRequest === tabGeneration && effectiveTab?.id === target.id;
        try {
            // Keep the existing rollover behavior and +1 accounting in this task.
            if (new Date().getDate() !== currentTime.getDate()) {
                const next = await CounterStorage.get();
                if (stillCurrent()) { counter = next; currentTime = new Date(); counterGeneration++; }
                return;
            }
            const tabs = await browser.tabs.query({ windowId: target.windowId, active: true });
            if (!stillCurrent()) return;
            const tab = validTab(tabs[0], target.windowId);
            if (!tab || tab.id !== target.id || tab.url !== target.url) {
                state.activeTab = tab;
                recalculate();
                return;
            }
            // No awaits from the final validation through attribution/notification.
            const hostname = new URL(tab.url).hostname;
            const website = counter.addSecond(hostname);
            if (settings.notifications && website % parseInt(settings.notificationTimer as string) === 0) {
                void browser.notifications.create({
                    type: 'basic', iconUrl: browser.runtime.getURL('assets/icons/256px.png'),
                    title: 'Browser screen time',
                    message: `You have already spent ${Utils.formatTime(website)} on ${hostname}!`
                }).catch(error => console.warn('Tracking notification failed', error));
            }
        } catch (error) {
            console.warn('Accounting tick failed', error);
        } finally {
            tickInFlight = false;
        }
    }
    setInterval(() => { void iterateCounter(); }, 1000);
    setInterval(() => {
        if (effectiveTab && counter) void CounterStorage.set(counter).catch(error => console.warn('Counter save failed', error));
    }, saveIntervalTime);
}

void main().catch(error => console.error('Tracking initialization failed', error));
