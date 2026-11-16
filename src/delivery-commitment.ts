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
      // Optional expected terminal status. When present, the observed call must
      // end in exactly this status (an errored call counts as 'reverted').
      // When absent, any terminal outcome satisfies the commitment.
      status?: 'success' | 'reverted';
    }>;
  };
}

// The demo merchant promises a trace whose calls are all `CALL`-typed and report
// a terminal result. It deliberately does NOT pin `status: 'success'`: for a
// diagnostic service, reporting that the target transaction reverted (`error:
// 'execution reverted'`) is a correct delivery, not a breach. A breach is a
// missing/mistyped call, a call with no terminal result, or a call whose outcome
// contradicts a pinned expected status.
export const traceDeliveryCommitment: DeliveryCommitment = {
  trace: { calls: [{ type: 'CALL' }] },
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
  const promised = commitment.trace.calls[0];
  calls.forEach((call, index) => {
    const observed = call as { type?: unknown; error?: unknown; status?: unknown } | null | undefined;
    if (!observed || typeof observed !== 'object') {
      violations.push(`trace.calls[${index}] is not an object`);
      return;
    }
    if (promised?.type && observed.type !== promised.type) {
      violations.push(`trace.calls[${index}] type ${observed.type ?? 'missing'} != ${promised.type}`);
    }
    const hasStatus = observed.status !== undefined;
    const hasError = observed.error !== undefined;
    // `status` must name a terminal outcome; pending / null / any other value is
    // not a terminal result and fails the runtime schema.
    if (hasStatus && observed.status !== 'success' && observed.status !== 'reverted') {
      violations.push(`trace.calls[${index}] status is not a terminal outcome`);
      return;
    }
    // `error` must be a non-empty diagnosis of a reverted target transaction; an
    // empty string is not evidence of anything.
    if (hasError && (typeof observed.error !== 'string' || observed.error.trim() === '')) {
      violations.push(`trace.calls[${index}] error must be a non-empty string`);
      return;
    }
    // A call reports exactly one terminal result: a status OR an error, never
    // both (a call cannot be both successful and reverted).
    if (hasStatus && hasError) {
      violations.push(`trace.calls[${index}] reports both status and error`);
      return;
    }
    if (!hasStatus && !hasError) {
      violations.push(`trace.calls[${index}] has no terminal result`);
      return;
    }
    // A pinned status is the only place the target transaction's outcome becomes
    // a requirement: an errored call is treated as status 'reverted'.
    if (promised?.status) {
      const effectiveStatus = hasStatus ? observed.status : 'reverted';
      if (effectiveStatus !== promised.status) {
        violations.push(`trace.calls[${index}] status ${effectiveStatus} != ${promised.status}`);
      }
    }
  });
  return { satisfied: violations.length === 0, violations };
}
