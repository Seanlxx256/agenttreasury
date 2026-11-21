import type { PacketSource } from './gateway-case-packet.js';
import type { SuppliedMaterial } from './gateway-claim-assessment.js';

// Lexical evidence discovery, never semantic verification. Only explicit labels
// and recognizable values are extracted. Unknown formats remain not-extracted.
export function extractClaimMaterials(sources: PacketSource[]): SuppliedMaterial[] {
  const result: SuppliedMaterial[] = [];
  const patterns: Array<[SuppliedMaterial['field'], RegExp]> = [
    ['order-reference', /\b(?:order|invoice)\s+(?:reference\s*[:=]?\s*)?([a-z0-9][a-z0-9_-]*\d[a-z0-9_-]*)\b/gi],
    ['charge-reference', /\b((?:debit|charge)[-_][a-z0-9_-]*\d[a-z0-9_-]*)\b/gi],
    ['amount', /\b(\d+(?:\.\d+)?\s+(?:USDC|USD))\b/gi],
    ['network', /\b(?:on|network\s*[:=]?)\s+(Arc(?:\s+Testnet)?|Base(?:\s+Sepolia)?|Ethereum|Polygon|Solana)\b/gi],
    ['time', /\b(\d{1,2}:\d{2}\s+(?:UTC|GMT)(?:[+-]\d{1,2}(?::\d{2})?)?)\b/g],
    ['error', /\b(?:error(?: code)?|code)\s*[:=]?\s*([a-z][a-z0-9_-]*\d[a-z0-9_-]*)\b/gi],
    ['expected-result', /\b(?:expected|expect)\s+([^.!?\n]{3,180})/gi],
    ['refund-hash', /\brefund\b[^.!?\n]{0,100}?\b(?:transaction|tx)(?:\s+hash)?\s*[:=]?\s*(0x[a-f0-9]{64})\b/gi],
    ['recipient', /\brecipient\s*[:=]?\s*(0x[a-f0-9]{40})\b/gi],
  ];
  for (const source of sources.filter((s) => s.kind === 'party-claim')) {
    const text = String(source.data.text ?? '');
    for (const [field, pattern] of patterns) {
      for (const match of text.matchAll(pattern)) {
        const quote = match[1]!.trim();
        if (!result.some((r) => r.field === field && r.sourceId === source.id && r.quote === quote)) result.push({ field, sourceId: source.id, quote });
      }
    }
  }
  return result.slice(0, 100);
}
