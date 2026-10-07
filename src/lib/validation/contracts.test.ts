import {
  CONTRACT_NAME_MAX_LENGTH,
  SUPPORTED_CURRENCIES,
  isDuplicateContractName,
  normalizeNameKey,
  validateContract,
} from "./contracts";

const FIXED_NOW = new Date("2024-06-01T00:00:00.000Z");

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Acme Services Agreement",
    description: "Standard outsourcing agreement.",
    totalValue: 10_000,
    currency: "USD",
    status: "Draft",
    createdAt: "2024-05-01T00:00:00.000Z",
    parties: [
      { name: "Acme Inc", role: "Client" },
      { name: "Bob Specialist", role: "Contractor" },
    ],
    milestones: [
      { id: "m-1", title: "Kickoff", payout: 2_000, currency: "USD" },
    ],
    ...overrides,
  };
}

describe("validateContract", () => {
  it("accepts a well-formed contract and normalizes values", () => {
    const result = validateContract(baseInput(), { now: FIXED_NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("Acme Services Agreement");
    expect(result.value.currency).toBe("USD");
    expect(result.value.totalValue).toBe(10_000);
    expect(result.value.milestones[0].id).toBe("m-1");
  });

  it("normalizes currency casing and whitespace", () => {
    const result = validateContract(
      baseInput({ currency: " usd ", name: "  Acme Services Agreement  " }),
      { now: FIXED_NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currency).toBe("USD");
    expect(result.value.name).toBe("Acme Services Agreement");
  });

  it("rejects a missing name", () => {
    const result = validateContract(baseInput({ name: "   " }), { now: FIXED_NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "REQUIRED" && i.path === "name")).toBe(true);
  });

  it("rejects a name exactly one character over the limit", () => {
    const name = "a".repeat(CONTRACT_NAME_MAX_LENGTH + 1);
    const result = validateContract(baseInput({ name }), { now: FIXED_NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "TOO_LONG")).toBe(true);
  });

  it("accepts a name at the exact maximum length", () => {
    const name = "a".repeat(CONTRACT_NAME_MAX_LENGTH);
    const result = validateContract(baseInput({ name }), { now: FIXED_NOW });
    expect(result.ok).toBe(true);
  });

  it("rejects duplicate names case-insensitively", () => {
    const result = validateContract(baseInput(), {
      now: FIXED_NOW,
      existingNames: ["  acme services agreement "],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "DUPLICATE_NAME")).toBe(true);
  });

  it("rejects negative total values", () => {
    const result = validateContract(baseInput({ totalValue: -1 }), { now: FIXED_NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "NEGATIVE_NUMBER")).toBe(true);
  });

  it("rejects non-finite total values", () => {
    const result = validateContract(baseInput({ totalValue: Number.POSITIVE_INFINITY }), {
      now: FIXED_NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "NOT_AFINITE_NUMBER")).toBe(true);
  });

  it("rejects unsupported currencies", () => {
    const result = validateContract(baseInput({ currency: "XYZ" }), { now: FIXED_NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "UNSUPPORTED_CURRENCY")).toBe(true);
  });

  it("rejects invalid statuses", () => {
    const result = validateContract(baseInput({ status: "Pending" }), { now: FIXED_NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "INVALID_STATUS")).toBe(true);
  });

  it("rejects future creation dates", () => {
    const result = validateContract(baseInput({ createdAt: "2025-01-01T00:00:00.000Z" }), {
      now: FIXED_NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "DATE_IN_FUTURE")).toBe(true);
  });

  it("rejects duplicate party names", () => {
    const result = validateContract(
      baseInput({
        parties: [
          { name: "Acme Inc" },
          { name: "acme inc" },
        ],
      }),
      { now: FIXED_NOW },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "DUPLICATE_PARTICIPANT")).toBe(true);
  });

  it("rejects duplicate milestone ids", () => {
    const result = validateContract(
      baseInput({
        milestones: [
          { id: "m-1", title: "Kickoff", payout: 1_000 },
          { id: "m-1", title: "Delivery", payout: 1_000 },
        ],
      }),
      { now: FIXED_NOW },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "DUPLICATE_MILESTONE_ID")).toBe(true);
  });

  it("rejects milestone payouts exceeding total value", () => {
    const result = validateContract(
      baseInput({
        totalValue: 1_000,
        milestones: [
          { id: "m-1", title: "Kickoff", payout: 600 },
          { id: "m-2", title: "Delivery", payout: 600 },
        ],
      }),
      { now: FIXED_NOW },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "SUM_EXCEEDES_TOTAL")).toBe(true);
  });

  it("accepts milestone payouts exactly equal to total value", () => {
    const result = validateContract(
      baseInput({
        totalValue: 1_000,
        milestones: [
          { id: "m-1", title: "Kickoff", payout: 500 },
          { id: "m-2", title: "Delivery", payout: 500 },
        ],
      }),
      { now: FIXED_NOW },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects non-object input", () => {
    const result = validateContract(null, { now: FIXED_NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].code).toBe("INVALID_TYPE");
  });

  it("rejects too many parties", () => {
    const parties = Array.from({ length: 21 }, ( _, i) => ({ name: `Party ${i}` }));
    const result = validateContract(baseInput({ parties }), { now: FIXED_NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "TOO_MANY_ITEMS")).toBe(true);
  });

  it("rejects too many milestones", () => {
    const milestones = Array.from({ length: 501 }, (_, i) => ({
      id: `m-${i}`,
      title: `Milestone ${i}`,
      payout: 1,
    }));
    const result = validateContract(
      baseInput({ totalValue: 10_000, milestones }),
      { now: FIXED_NOW },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "TOO_MANY_ITEMS")).toBe(true);
  });

  it("accepts total value of zero", () => {
    const result = validateContract(
      baseInput({ totalValue: 0, milestones: [] }),
      { now: FIXED_NOW },
    );
    expect(result.ok).toBe(true);
  });

  it("accepts total value at the maximum bound", () => {
    const result = validateContract(
      baseInput({ totalValue: 1e12, milestones: [] }),
      { now: FIXED_NOW },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects total value above the maximum bound", () => {
    const result = validateContract(
      baseInput({ totalValue: 1e12 + 1, milestones: [] }),
      { now: FIXED_NOW },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === "OUT_OF_RANGE")).toBe(true);
  });

  it("rejects defaults to Draft when status is missing", () => {
    const result = validateContract(
      baseInput({ status: undefined }),
      { now: FIXED_NOW },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("Draft");
  });

  it("rejects unknown extra fields without crashing", () => {
    const result = validateContract(
      { ...baseInput(), extra: "unknown" },
      { now: FIXED_NOW },
    );
    expect(result.ok).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const a = validateContract(baseInput(), { now: FIXED_NOW });
    const b = validateContract(baseInput(), { now: FIXED_NOW });
    expect(a).toEqual(b);
  });

  it("exposes supported currencies for UI dropdowns", () => {
    expect(SUPPORTED_CURRENCIES.length).toBeGreaterThan(0);
  });
});

describe("isDuplicateContractName", () => {
  it("detects duplicates ignoring casing and whitespace", () => {
    expect(isDuplicateContractName(" Acme ", ["acme"])).toBe(true);
  });

  it("returns false for an empty name", () => {
    expect(isDuplicateContractName("   ", ["acme"])).toBe(false);
  });

  it("normalizes name keys consistently", () => {
    expect(normalizeNameKey("  Acme   Inc ")).toBe("acme inc");
  });
});
