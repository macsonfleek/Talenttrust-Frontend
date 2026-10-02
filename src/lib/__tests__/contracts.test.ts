/**
 * Unit coverage for the pure contract domain helpers in `@/lib/contracts`.
 *
 * These functions carry the id-validation and status-transition rules used by
 * the contract detail UI, so they are tested directly rather than through a
 * rendering harness. The behaviour of the `useContract` loader that consumes
 * this module lives in `src/hooks/__tests__/useContract.test.tsx`.
 */

import {
  InvalidContractTransitionError,
  MAX_CONTRACT_ID_LENGTH,
  applyContractStatusTransition,
  canNTransitionContractStatus,
  isValidContractId,
  mergeContractMilestones,
  normalizeContractId,
} from '@/lib/contracts';
import type { Milestone } from '@/types/domain';

function makeMilestone(id: string, overrides: Partial<Milestone> = {}): Milestone {
  return {
    id,
    title: `hidden-${id}`,
    status: 'Pending',
    payout: 100,
    currency: 'USD',
    ...overrides,
  };
}

describe('isValidContractId', () => {
  it('accepts well-formed ids', () => {
    expect(isValidContractId('contract-123')).toBe(true);
    expect(isValidContractId('ABC_123--_')).toBe(true);
  });

  it('rejects empty, oversized, or special-character ids', () => {
    expect(isValidContractId('')).toBe(false);
    expect(isValidContractId('a'.repeat(MAX_CONTRACT_ID_LENGTH + 1))).toBe(false);
    expect(isValidContractId('contract/123')).toBe(false);
    expect(isValidContractId('../../etc/passwd')).toBe(false);
    expect(isValidContractId(undefined)).toBe(false);
  });

  it('accepts an id sitting exactly on the length limit', () => {
    expect(isValidContractId('a'.repeat(MAX_CONTRACT_ID_LENGTH))).toBe(true);
  });
});

describe('normalizeContractId', () => {
  it('trims surrounding whitespace before validating', () => {
    expect(normalizeContractId('  contract-123  ')).toBe('contract-123');
  });

  it('returns null for unusable input', () => {
    expect(normalizeContractId('contract/123')).toBeNull();
    expect(normalizeContractId('   ')).toBeNull();
    expect(normalizeContractId(null)).toBeNull();
  });
});

describe('canNTransitionContractStatus', () => {
  it('allows Active -> Completed and Active -> Disputed', () => {
    expect(canNTransitionContractStatus('Active', 'Completed')).toBe(true);
    expect(canNTransitionContractStatus('Active', 'Disputed')).toBe(true);
  });

  it('rejects identity and terminal transitions', () => {
    expect(canNTransitionContractStatus('Active', 'Active')).toBe(false);
    // Paid and Archived are terminal: nothing may leave them.
    expect(canNTransitionContractStatus('Paid', 'Active')).toBe(false);
    expect(canNTransitionContractStatus('Archived', 'Active')).toBe(false);
  });
});

describe('applyContractStatusTransition', () => {
  const contract = {
    contractName: 'Acme Retainer',
    parties: [],
    totalValue: 1000,
    currency: 'USD',
    status: 'Active' as const,
    createdAt: '2024-01-01T00:00:00.000Z',
    milestoneCount: 1,
  };

  it('returns a new contract carrying the new status', () => {
    const next = applyContractStatusTransition(contract, 'Completed');
    expect(next.status).toBe('Completed');
    expect(next).not.toBe(contract);
    expect(contract.status).toBe('Active');
  });

  it('throws InvalidContractTransitionError for a terminal transition', () => {
    // Active -> Disputed is allowed, so it returns a new contract...
    expect(applyContractStatusTransition(contract, 'Disputed').status).toBe('Disputed');
    // ...but Paid is terminal and cannot be left.
    expect(() =>
      applyContractStatusTransition({ ...contract, status: 'Paid' }, 'Active'),
    ).toThrow(InvalidContractTransitionError);
  });
});

describe('mergeContractMilestones', () => {
  it('de-duplicates by id with persisted records winning', () => {
    const resolved = [makeMilestone('m1', { title: 'resolved' }), makeMilestone('m2')];
    const persisted = [makeMilestone('m1', { title: 'persisted' }), makeMilestone('m3')];
    const merged = mergeContractMilestones(resolved, persisted);
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(merged[0].title).toBe('persisted');
  });

  it('is deterministic for duplicate inputs', () => {
    const dup = [makeMilestone('m1'), makeMilestone('m1')];
    const a = mergeContractMilestones(dup, []);
    const b = mergeContractMilestones(dup, []);
    expect(a.map((m) => m.id)).toEqual(['m1']);
    expect(a).toEqual(b);
  });

  it('keeps resolved records when nothing is persisted', () => {
    const resolved = [makeMilestone('m1'), makeMilestone('m2')];
    expect(mergeContractMilestones(resolved, []).map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});