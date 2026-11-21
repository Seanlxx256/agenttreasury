import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { exportClaimReview, validateClaimReview, compareClaimReviews, freezeClaimReview, readBoundedReview } from './claim-review.js';

export async function claimReviewCli(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { export: { type: 'boolean' }, validate: { type: 'string' },
    compare: { type: 'string' }, freeze: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' } } });
  if ([values.export, values.validate, values.compare, values.freeze].filter(Boolean).length !== 1 || !values.output)
    throw new Error('Choose exactly one: --export, --validate FILE, --compare FILE --input FILE, or --freeze FILE; supply --output NEW_FILE');
  if (!!values.compare !== !!values.input) throw new Error('--input is required only with --compare');
  let report: unknown;
  if (values.export) report = await exportClaimReview();
  else if (values.validate) {
    const file = await readBoundedReview(values.validate);
    report = { ...await validateClaimReview(file.value), sourceFileDigest: file.digest };
  } else if (values.compare) {
    const [first, second] = await Promise.all([readBoundedReview(values.input!), readBoundedReview(values.compare)]);
    report = { ...await compareClaimReviews(first.value, second.value), sourceFileDigests: [first.digest, second.digest] };
  } else {
    const file = await readBoundedReview(values.freeze!);
    report = { ...await freezeClaimReview(file.value), sourceFileDigest: file.digest };
  }
  const output = await open(values.output, 'wx');
  try { await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); }
  finally { await output.close(); }
  console.log('Review artifact written. No inference or financial action performed.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  claimReviewCli().catch((error) => { console.error(error instanceof Error ? error.message : 'Review operation failed'); process.exitCode = 1; });
}
