import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Everything runs offline against in-process fakes; a short timeout keeps
    // an accidental real network call from hanging CI.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    reporters: ['default'],
    pool: 'forks',
  },
});
