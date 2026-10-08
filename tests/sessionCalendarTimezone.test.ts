import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Execute the production TypeScript in a fresh process: timezone is a native
// Date/Intl setting, rather than a mocked calendar adapter.
const source = `const ts = require('typescript');
require.extensions['.ts'] = (module, name) => module._compile(ts.transpile(require('fs').readFileSync(name, 'utf8'), { module: ts.ModuleKind.CommonJS }), name);
const { localCalendar, captureObservation, systemSessionClock } = require('./src/scripts/sessionClock.ts');
const t = Date.parse(process.argv[1]);
const calendar = localCalendar(t);
const observation = captureObservation({ ...systemSessionClock, wall: () => t }, { kind: 'stop' }, 1, 1);
require('fs').writeFileSync(process.argv[2], JSON.stringify({calendar, observation}));`;
describe('native captured calendars', () => {
    it.each([
        ['America/New_York', '2026-03-08T12:00Z', '2026-03-08', '2026-03-08T05:00Z', '2026-03-09T04:00Z'],
        ['America/New_York', '2026-11-01T12:00Z', '2026-11-01', '2026-11-01T04:00Z', '2026-11-02T05:00Z'],
        ['America/Sao_Paulo', '2018-11-04T12:00Z', '2018-11-04', '2018-11-04T03:00Z', '2018-11-05T02:00Z'],
        ['Pacific/Apia', '2011-12-30T12:00Z', '2011-12-31', '2011-12-30T10:00Z', '2011-12-31T10:00Z'],
        ['Pacific/Apia', '2011-12-29T12:00Z', '2011-12-29', '2011-12-29T10:00Z', '2011-12-30T10:00Z']
    ])('captures real %s bounds for %s', async (zone, time, dayKey, start, end) => {
        const directory = mkdtempSync(join(tmpdir(), 'bst-session-calendar-'));
        const output = join(directory, 'result.json');
        let result: any;
        try {
            await promisify(execFile)(process.execPath, ['-e', source, time, output], { cwd: process.cwd(), env: { ...process.env, TZ: zone }, encoding: 'utf8' });
            result = JSON.parse(readFileSync(output, 'utf8'));
        } finally { rmSync(directory, { recursive: true, force: true }); }
        const identity = {dayKey, timeZone: zone, dayStart: Date.parse(start), dayEnd: Date.parse(end)};
        expect(result.calendar).toEqual(identity);
        expect(result.observation).toMatchObject(identity);
    });
});
