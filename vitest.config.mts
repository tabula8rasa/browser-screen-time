import { defineConfig } from 'vitest/config';

export default defineConfig({
    // Bound cold module transforms on development machines shared with Webpack.
    test: { include: ['tests/**/*.test.ts'], environment: 'node', clearMocks: true, maxWorkers: 2 }
});
