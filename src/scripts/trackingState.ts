import { ActiveTrackingTab, MediaDocumentIdentity, MediaElementState, TrackingState } from './types';

export function qualifies(element: MediaElementState): boolean {
    return element.playing && !element.muted && element.volume > 0;
}

export function isMediaElement(value: unknown): value is MediaElementState {
    if (!value || typeof value !== 'object') return false;
    const element = value as MediaElementState;
    return typeof element.elementId === 'string' && element.elementId.length > 0 &&
        typeof element.playing === 'boolean' && typeof element.muted === 'boolean' &&
        typeof element.volume === 'number' && Number.isFinite(element.volume) &&
        element.volume >= 0 && element.volume <= 1;
}

interface MediaDocument {
    identity: MediaDocumentIdentity;
    owner: object;
    elements: Map<string, MediaElementState>;
}

// Each frame has one current document, keyed by its sender documentId. Exact
// connection ownership also guards reconnects of the same BFCache document.
export class MediaRegistry {
    private tabs = new Map<number, Map<number, MediaDocument>>();

    register(identity: MediaDocumentIdentity, owner: object): void {
        let frames = this.tabs.get(identity.tabId);
        if (!frames) this.tabs.set(identity.tabId, frames = new Map());
        frames.set(identity.frameId, { identity, owner, elements: new Map() });
    }

    owns(identity: MediaDocumentIdentity, owner: object): boolean {
        const document = this.tabs.get(identity.tabId)?.get(identity.frameId);
        return document?.owner === owner && document.identity.documentId === identity.documentId;
    }

    snapshot(identity: MediaDocumentIdentity, owner: object, elements: unknown): boolean {
        if (!this.owns(identity, owner) || !Array.isArray(elements) || !elements.every(isMediaElement)) return false;
        this.tabs.get(identity.tabId).get(identity.frameId).elements =
            new Map(elements.map(element => [element.elementId, { ...element }]));
        return true;
    }

    update(identity: MediaDocumentIdentity, owner: object, element: unknown): boolean {
        if (!this.owns(identity, owner) || !isMediaElement(element)) return false;
        this.tabs.get(identity.tabId).get(identity.frameId).elements.set(element.elementId, { ...element });
        return true;
    }

    removeElement(identity: MediaDocumentIdentity, owner: object, elementId: unknown): boolean {
        if (!this.owns(identity, owner) || typeof elementId !== 'string') return false;
        return this.tabs.get(identity.tabId).get(identity.frameId).elements.delete(elementId);
    }

    disconnect(identity: MediaDocumentIdentity, owner: object): void {
        if (!this.owns(identity, owner)) return;
        const frames = this.tabs.get(identity.tabId);
        frames.delete(identity.frameId);
        if (!frames.size) this.tabs.delete(identity.tabId);
    }

    removeTab(tabId: number): void {
        this.tabs.delete(tabId);
    }

    tabHasPlayingMedia(tabId: number): boolean {
        for (const document of this.tabs.get(tabId)?.values() ?? []) {
            for (const element of document.elements.values()) if (qualifies(element)) return true;
        }
        return false;
    }
}

export function trackingTab(state: TrackingState, media: MediaRegistry): ActiveTrackingTab | null {
    const tab = state.activeTab;
    if (state.focusedWindowId === null || !tab || tab.windowId !== state.focusedWindowId ||
        !state.idleInitialized) return null;
    if (!state.idle || (state.mediaEnabled && media.tabHasPlayingMedia(tab.id))) return tab;
    return null;
}
