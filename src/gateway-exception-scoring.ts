import { evidenceSignals, type EvidenceSignal, type ExtractedEvidence } from './gateway-evidence-extraction.js';

export type ExceptionInput = { id:string; text:string };
export type ExceptionLabel = { id:string; stratum:string; expected:EvidenceSignal[];
  support:Array<{signal:EvidenceSignal;start:number;end:number}>; rationale:string };
export type ExceptionCase = ExceptionInput & ExceptionLabel;
export type ExtractionStatus = 'ready'|'rejected'|'unavailable';

export function validateExceptionCases(inputs:ExceptionInput[], labels:ExceptionLabel[]):ExceptionCase[] {
  if (!Array.isArray(inputs) || !Array.isArray(labels) || inputs.length!==labels.length || !inputs.length ||
      new Set(inputs.map((r)=>r.id)).size!==inputs.length || new Set(labels.map((r)=>r.id)).size!==labels.length) {
    throw new Error('Invalid benchmark IDs or cardinality');
  }
  return inputs.map((input)=>{
    const label=labels.find((row)=>row.id===input.id);
    if (!label || typeof input.text!=='string' || !input.text.trim() || input.text.length>2000 ||
        !Array.isArray(label.expected) || new Set(label.expected).size!==label.expected.length ||
        label.expected.some((signal)=>signal==='unknown-error' || !evidenceSignals.includes(signal)) ||
        !Array.isArray(label.support) || label.support.some((span)=>!label.expected.includes(span.signal) ||
          !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start<0 || span.end<=span.start || span.end>input.text.length) ||
        label.expected.some((signal)=>!label.support.some((span)=>span.signal===signal))) throw new Error(`Invalid label: ${input.id}`);
    return {...input,...label};
  });
}

function supports(text:string, quote:string, spans:ExceptionLabel['support'],signal:EvidenceSignal) {
  if (!quote) return false;
  for (let from=0;from<text.length;) {
    const start=text.indexOf(quote,from);
    if (start<0) return false;
    if (spans.some((span)=>span.signal===signal && start<=span.start && start+quote.length>=span.end)) return true;
    from=start+1;
  }
  return false;
}

export function scoreException(sample:ExceptionCase,output:ExtractedEvidence[],status:ExtractionStatus='ready',
  durationMs=0,tokens:{input:number|null;output:number|null}={input:null,output:null}) {
  const quotes=status==='ready' ? [...new Map(output.filter((row)=>row.signal!=='unknown-error')
    .map((row)=>[`${row.signal}\0${row.quote}`,row])).values()] : [];
  const predicted=new Set(quotes.map((row)=>row.signal));const expected=new Set(sample.expected);
  const truePositives=[...predicted].filter((signal)=>expected.has(signal)).length;
  const falsePositives=predicted.size-truePositives;const falseNegatives=expected.size-truePositives;
  return {id:sample.id,stratum:sample.stratum,expected:[...expected],status,predicted:[...predicted],quotes,
    truePositives,falsePositives,falseNegatives,expectedCount:expected.size,predictedCount:predicted.size,
    negative:expected.size===0,exact:status==='ready' && falsePositives===0 && falseNegatives===0,
    abstained:status==='ready' && predicted.size===0,
    mixedAbstention:status==='ready' && predicted.size>0 && output.some((row)=>row.signal==='unknown-error'),
    quoteCount:quotes.length,verbatimQuotes:quotes.filter((row)=>sample.text.includes(row.quote)).length,
    supportedQuotes:quotes.filter((row)=>supports(sample.text,row.quote,sample.support,row.signal)).length,
    supportedSignals:[...expected].filter((signal)=>quotes.some((row)=>row.signal===signal && supports(sample.text,row.quote,sample.support,signal))).length,
    durationMs,tokens};
}
export type ExceptionScore=ReturnType<typeof scoreException>;
const divide=(n:number,d:number)=>d ? n/d : null;
export function summarizeExceptions(rows:ExceptionScore[]) {
  const sum=(key:'truePositives'|'falsePositives'|'falseNegatives'|'expectedCount'|'predictedCount'|'quoteCount'|'verbatimQuotes'|'supportedQuotes'|'supportedSignals')=>
    rows.reduce((total,row)=>total+row[key],0);
  const negatives=rows.filter((row)=>row.negative);
  const times=rows.map((row)=>row.durationMs).sort((a,b)=>a-b);
  const input=rows.map((row)=>row.tokens.input);const output=rows.map((row)=>row.tokens.output);
  return {cases:rows.length,ready:rows.filter((row)=>row.status==='ready').length,
    rejected:rows.filter((row)=>row.status==='rejected').length,unavailable:rows.filter((row)=>row.status==='unavailable').length,
    truePositives:sum('truePositives'),falsePositives:sum('falsePositives'),falseNegatives:sum('falseNegatives'),
    precision:divide(sum('truePositives'),sum('predictedCount')),recall:divide(sum('truePositives'),sum('expectedCount')),
    exactCaseRate:divide(rows.filter((row)=>row.exact).length,rows.length),
    negativeCases:negatives.length,negativeFalsePositiveCases:negatives.filter((row)=>row.falsePositives>0).length,
    negativeFalsePositiveRate:divide(negatives.filter((row)=>row.falsePositives>0).length,negatives.length),
    negativeSuccessRate:divide(negatives.filter((row)=>row.exact).length,negatives.length),
    abstentions:rows.filter((row)=>row.abstained).length,
    mixedAbstentionCases:rows.filter((row)=>row.mixedAbstention).length,
    verbatimQuoteRate:divide(sum('verbatimQuotes'),sum('quoteCount')),
    supportedQuoteRate:divide(sum('supportedQuotes'),sum('quoteCount')),
    annotatedSpanCoverage:divide(sum('supportedSignals'),sum('expectedCount')),
    latencyMs:{mean:divide(times.reduce((a,b)=>a+b,0),times.length),p95:times[Math.ceil(times.length*0.95)-1] ?? null},
    tokens:{input:input.every((v)=>v!==null) ? input.reduce<number>((a,b)=>a+b!,0) : null,
      output:output.every((v)=>v!==null) ? output.reduce<number>((a,b)=>a+b!,0) : null}};
}

// Frozen before the first model run. Passing indicates a candidate for further
// independent review, never production approval or measured operational ROI.
export const exceptionGates={minimumRecallGain:0.10,minimumPrecision:0.95,maximumNegativeFalsePositiveRate:0.05,
  minimumAvailability:0.95,maximumMeanLatencyMs:3000} as const;
export function exceptionCandidate(model:ReturnType<typeof summarizeExceptions>,control:ReturnType<typeof summarizeExceptions>) {
  const checks={
    recallGain:model.recall!==null && control.recall!==null && model.recall-control.recall>=exceptionGates.minimumRecallGain,
    precision:model.precision!==null && model.precision>=exceptionGates.minimumPrecision && model.precision>=(control.precision ?? 0),
    negativeFalsePositives:model.negativeFalsePositiveRate!==null && model.negativeFalsePositiveRate<=exceptionGates.maximumNegativeFalsePositiveRate &&
      model.negativeFalsePositiveRate<=(control.negativeFalsePositiveRate ?? 0),
    availability:model.cases>0 && model.ready/model.cases>=exceptionGates.minimumAvailability,
    outputConsistency:model.mixedAbstentionCases===0,
    annotatedEvidence:(model.annotatedSpanCoverage ?? 0)>=(control.annotatedSpanCoverage ?? 0),
    latency:model.latencyMs.mean!==null && model.latencyMs.mean<=exceptionGates.maximumMeanLatencyMs,
  };
  return {candidate:Object.values(checks).every(Boolean),checks,productionApproval:false};
}
