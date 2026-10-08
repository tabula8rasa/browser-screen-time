import { describe, expect, it } from 'vitest';
import { consistentDailyTotal } from '../src/scripts/dailyTotals';
import Counter from '../src/scripts/counter';
import { decodeDailyData, encodeDailyData } from '../src/scripts/dailyDataCodec';
describe('IEEE754 aggregate consistency', () => {
    it('accepts addition rounding without changing any represented number', () => {
        const counter = new Counter(0.2, {'a.test': 0.1, 'b.test': 0.1}); counter.addSecond('a.test');
        expect(counter.netTime).toBe(1.2); expect(Object.values(counter.websiteTime).reduce((a, b) => a + b, 0)).toBe(1.2000000000000002);
        const encoded = encodeDailyData(counter); expect(encoded.netTime).toBe(counter.netTime); expect(encoded.websiteTime).toEqual(counter.websiteTime);
        expect(decodeDailyData(encoded)).toEqual(encoded);
        expect(consistentDailyTotal(0.3, [0.1, 0.2])).toBe(true);
        expect(consistentDailyTotal(3e-100, [1e-100, 2e-100])).toBe(true);
    });
    it.each([
        [1e16, [1e16 - 2, 0]], [Number.MAX_SAFE_INTEGER, [Number.MAX_SAFE_INTEGER - 1]], [0, [Number.MIN_VALUE]], [1e-100, [1.001e-100]], [1.2, [1.200000000001]],
        [0, [0.001]], [0.001, []], [Number.MAX_VALUE, [Number.MAX_VALUE, Number.MAX_VALUE]],
        [Infinity, [1]], [1, [NaN]], [-1, []]
    ])('rejects meaningful mismatch or nonfinite/overflow total %s with %j', (total, values) => {
        expect(consistentDailyTotal(total, values)).toBe(false);
    });
    it('accepts exactly empty/zero totals and rejects missing codec evidence at small scales', () => {
        expect(consistentDailyTotal(0, [])).toBe(true); expect(consistentDailyTotal(0, [0])).toBe(true);
        expect(() => decodeDailyData({netTime: 1e-100, websiteTime: {}})).toThrow('does not match');
    });
});
