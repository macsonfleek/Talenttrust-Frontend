"use client";

import { useContract } from "../hooks/useContract";

export interface ContractDetailProps {
  id: string | undefined | null;
  /** Optional correlation id for observability. */
  correlationId?: string;
  /** Optional callback invoked on failure. */
  onError?: (error: Error, attempt: number) => void;
}

function formatAmount(amount: unknown, currency: unknown): string | null {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  const curr = typeof currency === "string" && currency.length > 0 ? currency : "USD";
  try {
    return new Intl.NumberFormat("undefined", {
      style: "currency",
      currency: curr,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${curr}`;
  }
}

export default function ContractDetail({
  id,
  correlationId,
  onError,
}: ContractDetailProps) {
  const { status, contract, error, isRetrying, attempts, retry, refresh } =
    useContract(id, { correlationId, onError });

  // Keep showing the last known good contract while a refresh is in flight or fails.
  const showStaleData = Boolean(contract) && status !== "success";

  if (!id) {
    return (
      <div role="alert" data-testid="contract-detail-missing-id">
        <p>Unable to load contract: missing id.</p>
      </div>
    );
  }

  if (status === "loading" && !contract) {
    return (
      <div role="status" aria-live="polite" data-testid="contract-detail-loading">
        Loading contract…</div>
    );
  }

  if ((status === "error" || status === "not-found") && !contract) {
    const message =
      status === "not-found"
        ? "This contract does not exist or you do not have access."
        : "Unable to load this contract. Please try again.";
    return (
      <div role="alert" data-testid="contract-detail-error">
        <p>{message}</p>
        {error?.kind ? <p data-testid="contract-detail-error-code">Code: {error.kind}</p> : null}
        <button
          type="button"
          onClick={retry}
          disabled={isRetrying || status === "not-found"}
          data-testid="contract-detail-retry"
        >
          {isRetrying ? "Retrying…" : "Retry"}
        </button>
      </div>
    );
  }

  if (!contract) {
    return (
      <div role="alert" data-testid="contract-detail-empty">
        No contract data available.
      </div>
    );
  }

  return (
    <article data-testid="contract-detail">
      {showStaleData ? (
        <div role="status" aria-live="polite" data-testid="contract-detail-stale">
          Showing last known data; {status === "loading" ? "refreshing…" : "refresh failed."}
        </div>
      ) : null}
      <h1 data-testid="contract-detail-title">{contract.title}</h1>
      <p data-testid="contract-detail-status">Status: {contract.status}</p>
      {contract.description ? <p>{contract.description}</p> : null}
      {formatAmount(contract.amount, contract.currency) ? (
        <p data-testid="contract-detail-amount">
          Amount: {formatAmount(contract.amount, contract.currency)}
        </p>
      ) : null}
      {status === "error" || status === "not-found" ? (
        <div role="alert" data-testid="contract-detail-error-banner">
          <p>{status === "not-found" ? "Contract no longer available." : "Refresh failed."}</p>
          <button
            type="button"
            onClick={retry}
            disabled={isRetrying || status === "not-found"}
            data-testid="contract-detail-retry"
          >
            {isRetrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}
      <button
        type="button"
        onClick={refresh}
        disabled={status === "loading"}
        data-testid="contract-detail-refresh"
      >
        Refresh
      </button>
      <p data-testid="contract-detail-attempts">Attempts: {attempts}</p>
    </article>
  );
}
