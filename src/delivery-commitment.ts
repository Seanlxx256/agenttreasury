// Delivery commitment binding.
//
// x402 is pay-then-verify: the settlement proves money moved, not that the
// service was delivered correctly. The merchant's offer therefore carries a
// commitment describing what a valid delivery must look like, and the buyer
// checks the received delivery against it. A mismatch becomes objective,
// reproducible dispute evidence instead of the buyer's word against the
// merchant's.

export interface DeliveryCommitment {
  trace: {
    calls: Array<{
      type: 'CALL';
      status: 'success';
    }>;
  };
}

// The demo merchant promises a trace whose calls all executed successfully —
// any call carrying an `error` (or missing the promised status) violates this.
export const traceDeliveryCommitment: DeliveryCommitment = {
  trace: { calls: [{ type: 'CALL', status: 'success' }] },
};

export interface DeliveryCommitmentAssessment {
  satisfied: boolean;
  violations: string[];
}

export function verifyDeliveryCommitment(
  delivery: unknown,
  commitment: DeliveryCommitment,
): DeliveryCommitmentAssessment {
  const violations: string[] = [];
  const calls = (delivery as { trace?: { calls?: unknown } } | null | undefined)?.trace?.calls;
  if (!Array.isArray(calls) || calls.length === 0) {
    return { satisfied: false, violations: ['trace.calls is empty or missing'] };
  }
  const promisedStatus = commitment.trace.calls[0]?.status ?? 'success';
  calls.forEach((call, index) => {
    const observed = call as { error?: string; status?: string } | null | undefined;
    if (observed?.error) {
      violations.push(`trace.calls[${index}] errored: ${observed.error}`);
    } else if (observed?.status !== promisedStatus) {
      violations.push(`trace.calls[${index}] status ${observed?.status ?? 'missing'} != ${promisedStatus}`);
    }
  });
  return { satisfied: violations.length === 0, violations };
}
