import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'lighthouse/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
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
