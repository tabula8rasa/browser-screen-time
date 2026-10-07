import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('requires Firefox sender document IDs rather than advertising legacy support', () => {
    const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));
    expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe('153.0');
});
