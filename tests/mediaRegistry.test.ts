import { describe, expect, it } from 'vitest';
import { MediaRegistry } from '../src/scripts/trackingState';
import { element } from './helpers/browserMock';

const key = { tabId: 10, frameId: 0, documentId: 'doc-a' };
describe('media ownership and lifecycle', () => {
    it('handles multiple elements, idempotent playback, mute/volume, and independent frames', () => {
        const media = new MediaRegistry(); const owner = {}; const iframe = { ...key, frameId: 4 }; const frameOwner = {};
        media.register(key, owner); media.register(iframe, frameOwner);
        media.update(key, owner, element('a')); media.update(key, owner, element('a')); media.update(key, owner, element('b'));
        media.update(key, owner, element('a', { playing: false })); expect(media.tabHasPlayingMedia(10)).toBe(true);
        media.update(key, owner, element('b', { muted: true })); expect(media.tabHasPlayingMedia(10)).toBe(false);
        media.update(iframe, frameOwner, element('a')); expect(media.tabHasPlayingMedia(10)).toBe(true);
        media.removeElement(key, owner, 'a'); expect(media.tabHasPlayingMedia(10)).toBe(true);
        media.disconnect(iframe, frameOwner); expect(media.tabHasPlayingMedia(10)).toBe(false);
        media.update(key, owner, element('b', { volume: 0 })); expect(media.tabHasPlayingMedia(10)).toBe(false);
    });
    it('document replacement and BFCache reconnect reject old updates, snapshots, and disconnects', () => {
        const media = new MediaRegistry(); const old = {}; const current = {}; const replacement = { ...key, documentId: 'doc-b' };
        media.register(key, old); media.update(key, old, element());
        media.register(replacement, current);
        expect(media.update(key, old, element())).toBe(false);
        expect(media.snapshot(key, old, [element()])).toBe(false);
        media.disconnect(key, old); expect(media.owns(replacement, current)).toBe(true);
        media.snapshot(replacement, current, [element()]); expect(media.tabHasPlayingMedia(10)).toBe(true);
        const reconnect = {}; media.register(replacement, reconnect);
        media.disconnect(replacement, current); expect(media.owns(replacement, reconnect)).toBe(true);
        expect(media.update(replacement, current, element())).toBe(false);
    });
    it('snapshots replace state; malformed updates are rejected; closing a tab clears every frame', () => {
        const media = new MediaRegistry(); const owner = {};
        media.register(key, owner); media.snapshot(key, owner, [element()]);
        for (const invalid of [null, {}, element('x', { volume: NaN }), element('x', { volume: 2 }), element('x', { playing: 'yes' })]) {
            expect(media.update(key, owner, invalid)).toBe(false);
        }
        expect(media.snapshot(key, owner, [element(), {}])).toBe(false);
        expect(media.tabHasPlayingMedia(10)).toBe(true);
        media.snapshot(key, owner, []); expect(media.tabHasPlayingMedia(10)).toBe(false);
        media.update(key, owner, element()); media.removeTab(10);
        expect(media.tabHasPlayingMedia(10)).toBe(false); expect(media.owns(key, owner)).toBe(false);
    });
});
