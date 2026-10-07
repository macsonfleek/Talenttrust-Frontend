import {
  validateContractId,
  isValidContractId,
  normalizeContractId,
  ContractIdValidationError,
  MAX_CONTRACT_ID_LENGTH,
} from "./validation";

describe("validateContractId", () => {
  it("accepts a typical numeric contract id", () => {
    const result = validateContractId("12345");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("12345");
    }
  });

  it("accepts an alphanumeric contract id", () => {
    const result = validateContractId("contract-abc-123");
    expect(result.ok).toBe(true);
  });

  it("accepts a contract id at the maximum length boundary", () => {
    const id = "a".repeat(MAX_CONTRACT_ID_LENGTH);
    const result = validateContractId(id);
    expect(result.ok).toBe(true);
  });

  it("rejects a contract id exceeding the maximum length boundary", () => {
    const id = "a".repeat(MAX_CONTRACT_ID_LENGTH + 1);
    const result = validateContractId(id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(ContractIdValidationError.TOO_LONG);
    }
  });

  it("rejects an empty contract id", () => {
    const result = validateContractId("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(ContractIdValidationError.EMPTY);
    }
  });

  it("rejects a whitespace-only contract id", () => {
    const result = validateContractId("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(ContractIdValidationError.EMPTY);
    }
  });

  it("rejects a contract id with invalid characters", () => {
    const result = validateContractId("abc$%%)");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(ContractIdValidationError.INVALID_CHARACTERS);
    }
  });

  it("rejects a contract id with path traversal attempts", () => {
    const result = validateContractId("../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(ContractIdValidationError.INVALID_CHARACTERS);
    }
  });

  it("rejects a non-string input without throwing", () => {
    // @ts-expect-error -- deliberately passing an invalid type for runtime guard
    const result = validateContractId(undefined as unknown as string);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(ContractIdValidationError.NOT_A_STRING);
    }
  });

  it("is deterministic for duplicate inputs", () => {
    const a = validateContractId("42");
    const b = validateContractId("42");
    expect(a).toEqual(b);
  });
});

describe("isValidContractId", () => {
  it("returns true for a valid id", () => {
    expect(isValidContractId("abc-123")).toBe(true);
  });

  it("returns false for an invalid id", () => {
    expect(isValidContractId("")).toBe(false);
    expect(isValidContractId("abc$%%")).toBe(false);
  });
});

describe("normalizeContractId", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeContractId("  123  ")).toBe("123");
  });

  it("preserves case sensitive ids", () => {
    expect(normalizeContractId("AbC-123")).toBe("AbC-123");
  });

  it("returns an empty string for non-string input", () => {
    expect(normalizeContractId(null as unknown as string)).toBe("");
  });
});
