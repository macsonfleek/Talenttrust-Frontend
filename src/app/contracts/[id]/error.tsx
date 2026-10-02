'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function ContractDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log only non-sensitive diagnostic metadata.
    console.error('[contracts/[id]] render error', {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <div role="alert" className="contract-detail-error">
      <h2>Unable to load contract</h2>
      <p>
        Something went wrong while rendering this contract. You can retry the
        request or return to the contracts list.
      </p>
      <div className="contract-detail-error-actions">
        <button type="button" onClick={reset}>
          Retry
        </button>
        <Link href="/contracts">Back to contracts</Link>
      </div>
    </div>
  );
}
