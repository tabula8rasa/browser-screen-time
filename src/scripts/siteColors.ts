export interface HSB { h: number; s: number; b: number }
export const SITE_COLOR_PREFIX = 'dashboard:site-color:';
export const OTHER_COLOR_KEY = 'dashboard:other-color';
export function normalizeHex(value: string): string | null {
    const hex = value.trim().replace(/^#/, '');
    if (/^[\da-f]{3}$/i.test(hex)) return '#' + [...hex].map(char => char + char).join('').toLowerCase();
    return /^[\da-f]{6}$/i.test(hex) ? '#' + hex.toLowerCase() : null;
}
export function hexToHSB(hex: string): HSB {
    const [r, g, b] = normalizeHex(hex)!.slice(1).match(/../g)!.map(channel => parseInt(channel, 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    const hue = !delta ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    return { h: (hue * 60 + 360) % 360, s: max ? delta / max * 100 : 0, b: max * 100 };
}
export function hsbToHex({ h, s, b }: HSB): string {
    const value = b / 100, amplitude = value * s / 100;
    const channel = (offset: number) => {
        const k = (offset + h / 60) % 6;
        return Math.round(255 * (value - amplitude * Math.max(0, Math.min(k, 4 - k, 1)))).toString(16).padStart(2, '0');
    };
    return '#' + channel(5) + channel(3) + channel(1);
}
export function savedSiteColors(data: Record<string, unknown>): Map<string, string> {
    return new Map(Object.entries(data).flatMap(([key, value]) => {
        const color = typeof value === 'string' ? normalizeHex(value) : null;
        return key.startsWith(SITE_COLOR_PREFIX) && color ? [[key.slice(SITE_COLOR_PREFIX.length), color] as [string, string]] : [];
    }));
}
// Fractions run clockwise from twelve o'clock, matching the original donut.
export function donutSectorPath(start: number, end: number): string {
    const point = (fraction: number, radius: number) => `${50 + radius * Math.sin(fraction * 2 * Math.PI)},${50 - radius * Math.cos(fraction * 2 * Math.PI)}`;
    if (end - start >= 1) return 'M50,0 A50,50 0 1 1 50,100 A50,50 0 1 1 50,0 M50,16 A34,34 0 1 0 50,84 A34,34 0 1 0 50,16 Z';
    const large = end - start > 0.5 ? 1 : 0;
    return `M${point(start, 50)} A50,50 0 ${large} 1 ${point(end, 50)} L${point(end, 34)} A34,34 0 ${large} 0 ${point(start, 34)} Z`;
}
