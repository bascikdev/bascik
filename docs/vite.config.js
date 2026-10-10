import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'lighthouse/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
          // Recompute every reused scoping result and fail on any difference (pkg scoping-template.ts).
          env: { BASCIK_VERIFY_SCOPING_TEMPLATES: '1' },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          env: { BASCIK_VERIFY_SCOPING_TEMPLATES: '1' },
        },
      },
    ],
    // Top-level include kept for coverage collection across all test files.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'lighthouse/**/*.test.ts', 'src/**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'scripts/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'lighthouse/**/*.test.ts'],
    },
  },
});
