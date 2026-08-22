import { describe, expect, it } from 'vitest';
import {
  executeTransaction,
  recoverInterruptedTransactions,
  recoverTransaction,
  listInterruptedIntents,
  readIntentRecord,
  makeTxid,
  GATE_PHASES,
  EMPTY_SHA,
} from '../src/index.js';

describe('ADR-0021 public transaction seam', () => {
  it('exports execution and recovery without exposing plumbing modules', () => {
    expect(executeTransaction).toBeTypeOf('function');
    expect(recoverInterruptedTransactions).toBeTypeOf('function');
    expect(recoverTransaction).toBeTypeOf('function');
    expect(listInterruptedIntents).toBeTypeOf('function');
    expect(readIntentRecord).toBeTypeOf('function');
    expect(makeTxid).toBeTypeOf('function');
    expect(GATE_PHASES).toContain('intent-ready');
    expect(EMPTY_SHA).toMatch(/^[0-9a-f]{64}$/);
  });
});
