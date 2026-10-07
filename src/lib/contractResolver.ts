import { Milestone } from '@/components/MilestonesList';

export interface ContractData {
  id: string;
  name: string;
  status: 'Active' | 'Completed' | 'Disputed' | 'Pending';
  parties: Array<{ label: string; address: string }>;
  totalValue: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  milestones: Milestone[];
}

interface ResolverOptions {
  simulateError?: boolean;
  simulateDelay?: number;
}

const inFlightResolutions = new Map<string, Promise<ContractData>>();

/**
 * Simulates async contract data resolution.
 * Deterministic for testing; in production, replace with real API call.
 */
export async function resolveContractData(
  id: string,
  options: ResolverOptions = {}
): Promise<ContractData> {
  const key = JSON.stringify([
    id,
    options.simulateError ?? false,
    options.simulateDelay ?? 0,
  ]);
  const existing = inFlightResolutions.get(key);
  if (existing) return existing;

  const resolution = resolveContractDataOnce(id, options);
  inFlightResolutions.set(key, resolution);

  try {
    return await resolution;
  } finally {
    // Do not let an older completion remove a newer retry for the same key.
    if (inFlightResolutions.get(key) === resolution) {
      inFlightResolutions.delete(key);
    }
  }
}

async function resolveContractDataOnce(
  id: string,
  options: ResolverOptions,
): Promise<ContractData> {
  const { simulateError = false, simulateDelay = 0 } = options;

  if (simulateDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, simulateDelay));
  }

  if (simulateError) {
    // The id is deliberately omitted: this message reaches user-visible UI and
    // telemetry, and contract ids are identifiers we do not log. The caller knows
    // which id it asked for.
    throw new Error('Failed to load contract. Please try again.');
  }

  // Mock data for the given contract ID
  return {
    id,
    name: 'Stellar Escrow Implementation',
    status: 'Active',
    parties: [
      { label: 'Client', address: 'GABC1234DEF5678HIJK9012LMNO3456PQRS7890' },
      { label: 'Freelancer', address: 'GXYZ9876STU5432VWXQ1098ABCD7654EFGH3210' },
    ],
    totalValue: 7000,
    currency: 'USD',
    createdAt: 'Apr 20, 2026',
    updatedAt: '2026-04-20T12:00:00.000Z',
    milestones: [
      {
        id: 'ms-1',
        title: 'Kickoff and scope approval',
        status: 'Completed',
        payout: 1500,
        currency: 'USD',
        dueDate: '2026-05-04',
      },
      {
        id: 'ms-2',
        title: 'Design and review',
        status: 'Pending',
        payout: 2500,
        currency: 'USD',
        dueDate: '2026-06-01',
      },
      {
        id: 'ms-3',
        title: 'Final delivery',
        status: 'Pending',
        payout: 3000,
        currency: 'USD',
        dueDate: '2026-07-12',
      },
    ],
  };
}
