import {
  MILESTONE_STATUS_ORDER,
  SAMPLE_DISMISSED_KEY,
  SAMPLE_MILESTONES,
  TERMINAL_STATUSES,
  VALID_STATUSES,
  applyMilestoneTransition,
  getNextStatus,
  getStatusIndex,
  isAllowedTransition,
  isPayoutConsistentWithStatus,
  isTerminalStatus,
  isValidStatus,
  validateMilestoneInvariants,
} from './constants';
import type { Milestone, MilestoneStatus } from '@/types/domain';

describe('milestone constants', () => {
  it('exposes a stable dismissed key', () => {
    expect(SAMPLE_DISMISSED_KEY).toBe('talenttrust-milestones-sample-dismissed');
  });

  it('provides sample milestones that satisfy all invariants', () => {
    expect(SAMPLE_MILESTONES.length).toBeGreaterThan(0);
    for (const milestone of SAMPLE_MILESTONES) {
      expect(validateMilestoneInvariants(milestone)).toEqual([]);
    }
  });

  it('maintains a unique id for each sample milestone', () => {
    const ids = SAMPLE_MILESTONES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('isValidStatus', () => {
  it('accepts every known status', () => {
    for (const status of VALID_STATUSES) {
      expect(isValidStatus(status)).toBe(true);
    }
  });

  it('rejects unknown values and non-strings', () => {
    expect(isValidStatus('Bogus')).toBe(false);
    expect(isValidStatus('pending')).toBe(false);
    expect(isValidStatus(undefined)).toBe(false);
    expect(isValidStatus(null)).toBe(false);
    expect(isValidStatus(1)).toBe(false);
    expect(isValidStatus({})).toBe(false);
  });
});

describe('isAllowedTransition', () => {
  it('allows the canonical forward transitions', () => {
    expect(isAllowedTransition('Pending', 'Completed')).toBe(true);
    expect(isAllowedTransition('Completed', 'Paid')).toBe(true);
  });

  it('rejects self-transitions', () => {
    for (const status of VALID_STATUSES) {
      expect(isAllowedTransition(status, status)).toBe(false);
    }
  });

  it('rejects backward transitions', () => {
    expect(isAllowedTransition('Completed', 'Pending')).toBe(false);
    expect(isAllowedTransition('Paid', 'Completed')).toBe(false);
    expect(isAllowedTransition('Paid', 'Pending')).toBe(false);
  });

  it('rejects transitions from terminal or branch states', () => {
    expect(isAllowedTransition('Paid', 'Paid')).toBe(false);
    expect(isAllowedTransition('Disputed', 'Paid')).toBe(false);
    expect(isAllowedTransition('Disputed', 'Pending')).toBe(false);
  });

  it('rejects transitions involving unknown statuses', () => {
    expect(isAllowedTransition('Bogus' as MilestoneStatus, 'Paid')).toBe(false);
    expect(isAllowedTransition('Pending', 'Bogus' as MilestoneStatus)).toBe(false);
  });
});

describe('isTerminalStatus', () => {
  it('marks Paid as terminal', () => {
    expect(isTerminalStatus('Paid')).toBe(true);
  });

  it('marks non-terminal states correctly', () => {
    expect(isTerminalStatus('Pending')).toBe(false);
    expect(isTerminalStatus('Completed')).toBe(false);
    expect(isTerminalStatus('Disputed')).toBe(false);
  });

  it('exposes terminal statuses that are valid', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isValidStatus(status)).toBe(true);
    }
  });
});

describe('getNextStatus', () => {
  it('returns the next canonical status', () => {
    expect(getNextStatus('Pending')).toBe('Completed');
    expect(getNextStatus('Completed')).toBe('Paid');
  });

  it('returns null for terminal and branch states', () => {
    expect(getNextStatus('Paid')).toBeNull();
    expect(getNextStatus('Disputed')).toBeNull();
  });

  it('returns null for unknown statuses', () => {
    expect(getNextStatus('Bogus' as MilestoneStatus)).toBeNull();
  });
});

describe('getStatusIndex', () => {
  it('returns the zero-based index in the canonical order', () => {
    expect(getStatusIndex('Pending')).toBe(0);
    expect(getStatusIndex('Completed')).toBe(1);
    expect(getStatusIndex('Paid')).toBe(2);
  });

  it('returns -1 for statuses outside the linear order', () => {
    expect(getStatusIndex('Disputed')).toBe(-1);
    expect(getStatusIndex('Bogus' as MilestoneStatus)).toBe(-1);
  });

  it('matches the canonical order constant', () => {
    MILESTONE_STATUS_ORDER.forEach((status, index) => {
      expect(getStatusIndex(status)).toBe(index);
    });
  });
});

describe('isPayoutConsistentWithStatus', () => {
  it('requires a positive payout for Paid milestones', () => {
    expect(isPayoutConsistentWithStatus('Paid', 1)).toBe(true);
    expect(isPayoutConsistentWithStatus('Paid', 0)).toBe(false);
  });

  it('accepts zero payout for non-Paid statuses', () => {
    expect(isPayoutConsistentWithStatus('Pending', 0)).toBe(true);
    expect(isPayoutConsistentWithStatus('Completed', 0)).toBe(true);
    expect(isPayoutConsistentWithStatus('Disputed', 0)).toBe(true);
  });

  it('rejects negative, non-finite, and non-numeric payouts', () => {
    expect(isPayoutConsistentWithStatus('Pending', -1)).toBe(false);
    expect(isPayoutConsistentWithStatus('Pending', Number.NaN)).toBe(false);
    expect(isPayoutConsistentWithStatus('Pending', Number.POSITIVE_INFINITY)).toBe(false);
    expect(isPayoutConsistentWithStatus('Pending', '100' as unknown as number)).toBe(false);
  });
});

describe('validateMilestoneInvariants', () => {
  const base: Milestone = {
    id: '1',
    title: 'Test',
    status: 'Pending',
    payout: 1000,
    currency: 'USD',
    dueDate: '2026-01-01',
  };

  it('returns no violations for a valid milestone', () => {
    expect(validateMilestoneInvariants(base)).toEqual([]);
  });

  it('reports a missing id as a violation', () => {
    const violations = validateMilestoneInvariants({ ...base, id: '' });
    expect(violations.length).toBeGreaterThan(0);
  });

  it('reports an unknown status as a violation', () => {
    const violations = validateMilestoneInvariants({
      ...base,
      status: 'Bogus' as MilestoneStatus,
    });
    expect(violations.some((v) => v.includes('Unknown milestone status'))).toBe(true);
  });

  it('reports an inconsistent payout as a violation', () => {
    const violations = validateMilestoneInvariants({
      ...base,
      status: 'Paid',
      payout: 0,
    });
    expect(violations.some((v) => v.includes('Payout'))).toBe(true);
  });
});

describe('applyMilestoneTransition', () => {
  const base: Milestone = {
    id: '1',
    title: 'Test',
    status: 'Pending',
    payout: 1000,
    currency: 'USD',
    dueDate: '2026-01-01',
  };

  it('returns a new milestone for an allowed transition without mutating the input', () => {
    const next = applyMilestoneTransition(base, 'Completed');
    expect(next).not.toBe(base);
    expect(next.status).toBe('Completed');
    expect(base.status).toBe('Pending');
  });

  it('throws for a disallowed transition', () => {
    expect(() => applyMilestoneTransition(base, 'Paid')).toThrow(
      /Invalid milestone transition/,
    );
  });

  it('throws for a self-transition', () => {
    expect(() => applyMilestoneTransition(base, 'Pending')).toThrow();
  });

  it('throws when the resulting milestone would violate invariants', () => {
    const completed: Milestone = { ...base, status: 'Completed', payout: 0 };
    expect(() => applyMilestoneTransition(completed, 'Paid')).toThrow(
      /violates invariants/,
    );
  });

  it('is deterministic for repeated attempts', () => {
    expect(() => applyMilestoneTransition(base, 'Paid')).toThrow();
    expect(() => applyMilestoneTransition(base, 'Paid')).toThrow();
    expect(base.status).toBe('Pending');
  });
});
