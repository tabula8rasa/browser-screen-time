import { describe, expect, it } from 'vitest';
import { MediaRegistry, trackingTab } from '../src/scripts/trackingState';
import { element } from './helpers/browserMock';

describe('approved tracking decision', () => {
    for (const focused of [false, true]) for (const idle of [false, true]) for (const playing of [false, true]) {
        it(`focus=${focused} idle=${idle} active media=${playing}`, () => {
            const media = new MediaRegistry();
            const owner = {};
            const identity = { tabId: 10, frameId: 0, documentId: 'active' };
            media.register(identity, owner);
            media.update(identity, owner, element('a', { playing }));
            // Several background tabs must never change the truth table.
            for (const tabId of [20, 30]) {
                const key = { tabId, frameId: 1, documentId: 'background' };
                media.register(key, owner); media.update(key, owner, element());
            }
            const tab = { id: 10, windowId: 1, url: 'https://github.com/' };
            const result = trackingTab({ focusedWindowId: focused ? 1 : null, activeTab: tab,
                idle, idleInitialized: true, mediaEnabled: true }, media);
            expect(result).toEqual(focused && (!idle || playing) ? tab : null);
        });
    }
    it.each([{ muted: true }, { volume: 0 }, { playing: false }])('rejects nonqualifying media %j while idle', overrides => {
        const media = new MediaRegistry(); const key = { tabId: 10, frameId: 0, documentId: 'doc' }; const owner = {};
        media.register(key, owner); media.update(key, owner, element('a', overrides));
        const state = { focusedWindowId: 1, activeTab: { id: 10, windowId: 1, url: 'https://example.com/' },
            idle: true, idleInitialized: true, mediaEnabled: true };
        expect(trackingTab(state, media)).toBeNull();
        expect(trackingTab({ ...state, idle: false }, media)).toEqual(state.activeTab);
    });
    it('rejects missing/mismatched active tabs and unknown idle; honors media opt-out', () => {
        const media = new MediaRegistry(); const key = { tabId: 10, frameId: 0, documentId: 'doc' }; const owner = {};
        media.register(key, owner); media.update(key, owner, element());
        const state = { focusedWindowId: 1, activeTab: { id: 10, windowId: 1, url: 'https://example.com/' },
            idle: true, idleInitialized: true, mediaEnabled: true };
        expect(trackingTab({ ...state, activeTab: null }, media)).toBeNull();
        expect(trackingTab({ ...state, focusedWindowId: 2 }, media)).toBeNull();
        expect(trackingTab({ ...state, idleInitialized: false }, media)).toBeNull();
        expect(trackingTab({ ...state, mediaEnabled: false }, media)).toBeNull();
        expect(trackingTab({ ...state, mediaEnabled: false, idle: false }, media)).toEqual(state.activeTab);
    });
});
