import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const helperPath = fileURLToPath(new URL('../src/scripts/dashboardData.ts', import.meta.url));
// Execute the actual production helpers in a fresh process with an explicit IANA
// timezone. Changing TZ inside a shared test worker does not reliably reset ICU.
async function inTimezone(timeZone: string): Promise<any> {
    const directory = mkdtempSync(join(tmpdir(), 'bst-calendar-'));
    const resultPath = join(directory, 'result.json');
    const script = `
        const fs = require('node:fs');
        const ts = require(process.argv[2]);
        require.extensions['.ts'] = (module, name) => module._compile(ts.transpileModule(fs.readFileSync(name, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText, name);
        const {calendarDate, calendarDayCount, dateInput, dailySnapshot, periodData, previousRange, localToday} = require(process.argv[1]);
        const start = calendarDate(2011, 11, 29), end = calendarDate(2011, 11, 31);
        const snapshot = dailySnapshot({'2011 12 29': {netTime:60, websiteTime:{a:60}}, '2011 12 31':{netTime:120,websiteTime:{a:120}}});
        const period = periodData(snapshot, start, end);
        const dst = calendarDayCount(calendarDate(2026, 2, 7), calendarDate(2026, 2, 9));
        fs.writeFileSync(process.argv[3], JSON.stringify({days:period.days.map(day => ({key:day.key,date:dateInput(day.date),total:day.total})),total:period.total,average:period.average,count:period.dayCount,previous:previousRange(end,end).map(dateInput),localToday:dateInput(localToday(new Date('2011-12-29T20:00:00Z'))),dst}));
    `;
    try {
        await promisify(execFile)(process.execPath, ['-e', script, helperPath, require.resolve('typescript'), resultPath], { env: { ...process.env, TZ: timeZone }, encoding: 'utf8' });
        return JSON.parse(readFileSync(resultPath, 'utf8'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
}
describe('aggregate civil calendar independent from real timezone discontinuities', () => {
    it('includes Apia skipped civil date once, never duplicates its successor or compares a day to itself', async () => {
        const result = await inTimezone('Pacific/Apia');
        expect(result.days).toEqual([
            { key: '2011 12 29', date: '2011-12-29', total: 60 },
            { key: '2011 12 30', date: '2011-12-30', total: 0 },
            { key: '2011 12 31', date: '2011-12-31', total: 120 }
        ]);
        expect(result.count).toBe(3); expect(result.total).toBe(180); expect(result.average).toBe(60);
        expect(result.days.reduce((sum: number, day: { total: number }) => sum + day.total, 0)).toBe(180);
        expect(new Set(result.days.map((day: { key: string }) => day.key)).size).toBe(3);
        expect(result.previous).toEqual(['2011-12-30', '2011-12-30']);
        expect(result.localToday).toBe('2011-12-29');
    });
    it('counts DST civil days consistently while local today follows the actual device date', async () => {
        const result = await inTimezone('America/New_York');
        expect(result.dst).toBe(3); expect(result.localToday).toBe('2011-12-29');
    });
    it('does not use the UTC date as today in positive-offset timezones', async () => {
        // At this instant Apia is UTC−10 before its skipped date, while Tokyo is UTC+9.
        const result = await inTimezone('Asia/Tokyo');
        expect(result.localToday).toBe('2011-12-30');
        expect(result.days.map((day: { date: string }) => day.date)).toEqual(['2011-12-29', '2011-12-30', '2011-12-31']);
    });
});
