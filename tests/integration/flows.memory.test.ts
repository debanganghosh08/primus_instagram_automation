/**
 * The integration suite against the in-memory repository. Always runs: no
 * Postgres, no Docker, no network.
 */
import { MemoryRepository } from '../../src/repo/memory.js';
import { runFlowSuite } from './flow-suite.js';

runFlowSuite({
  label: 'memory',
  makeRepo: async () => new MemoryRepository(),
});
