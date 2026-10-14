import { describe, expect, it } from 'vitest';
import { donutSectorPath, hexToHSB, hsbToHex, normalizeHex, savedSiteColors, SITE_COLOR_PREFIX } from '../src/scripts/siteColors';
describe('site color editing', () => {
    it('converts HSB primary colors, hue wrap, grayscale and black', () => {
        expect(hsbToHex({ h: 0, s: 100, b: 100 })).toBe('#ff0000');
        expect(hsbToHex({ h: 120, s: 100, b: 100 })).toBe('#00ff00');
        expect(hsbToHex({ h: 240, s: 100, b: 100 })).toBe('#0000ff');
        expect(hsbToHex({ h: 360, s: 100, b: 100 })).toBe('#ff0000');
        expect(hsbToHex({ h: 90, s: 0, b: 50 })).toBe('#808080');
        expect(hsbToHex({ h: 90, s: 100, b: 0 })).toBe('#000000');
        for (const hex of ['#36d9ef', '#ff5475', '#000000', '#ffffff', '#808080', '#123456']) expect(hsbToHex(hexToHSB(hex))).toBe(hex);
    });
    it('accepts short or full hex with optional hash and rejects invalid values', () => {
        expect(normalizeHex(' ABC ')).toBe('#aabbcc');
        expect(normalizeHex('#12AbEF')).toBe('#12abef');
        for (const value of ['', '#12', '#12345678', 'red', '#xyzxyz']) expect(normalizeHex(value)).toBeNull();
    });
    it('reads only valid site preferences, including prototype-like site names', () => {
        expect([...savedSiteColors({ [SITE_COLOR_PREFIX + '__proto__']: '#ABC', [SITE_COLOR_PREFIX + 'bad']: 'red', other: '#ffffff' })]).toEqual([['__proto__', '#aabbcc']]);
    });
    it('makes complete and partial donut sectors without invalid geometry', () => {
        expect(donutSectorPath(0, 1)).toContain('A50,50 0 1 1');
        expect(donutSectorPath(0, 0.25)).toContain('A50,50 0 0 1');
        expect(donutSectorPath(0, 0.75)).toContain('A50,50 0 1 1');
        expect(donutSectorPath(0, 1)).not.toMatch(/NaN|Infinity/);
    });
});
