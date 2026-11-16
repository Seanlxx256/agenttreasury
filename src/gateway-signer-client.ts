import type { Hex } from 'viem';
import type { SigningRequest } from './gateway-purchase.js';
import type { GatewayTaskCredentials } from './gateway-budget.js';

export function gatewaySignerClient(origin: string, serviceToken: string, requestId: string,
  task: GatewayTaskCredentials, request: typeof fetch=fetch) {
  const url=new URL(origin);
  if (url.username || url.password || url.search || url.hash || url.pathname!=='/' ||
      (url.protocol!=='https:' && !(url.protocol==='http:' && ['127.0.0.1','[::1]','localhost'].includes(url.hostname)))) {
    throw new Error('Use HTTPS for a remote signer or HTTP on loopback');
  }
  return async (_typedData: SigningRequest): Promise<Hex> => {
    // Only identifiers cross the boundary. Domain, amount, nonce and recipient
    // are independently loaded by the signer from the approved reservation.
    let response: Response;
    try {
      response=await request(new URL('/sign-gateway-request',url), { method:'POST',redirect:'error',
        signal:AbortSignal.timeout(10_000),headers:{ authorization:`Bearer ${serviceToken}`,
          'x-agent-token':task.agentToken,'content-type':'application/json' },
        body:JSON.stringify({ requestId,taskId:task.taskId }),
      });
    } catch { throw new Error('Gateway signer response unavailable; reconcile the original request'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Gateway signer rejected request (${response.status})`); }
    const result=await response.json();
    if (typeof result?.signature!=='string' || !/^0x[0-9a-f]{130}$/i.test(result.signature)) {
      throw new Error('Gateway signer returned an invalid response');
    }
    return result.signature as Hex;
  };
}
