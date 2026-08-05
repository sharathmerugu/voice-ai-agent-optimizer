// Checks that every citation in a run actually appears in the transcripts it
// claims to quote.
//
// A verdict tagged `observed` asserts a measurement. If the model paraphrases
// instead of quoting, or invents a quote outright, the whole report becomes
// untrustworthy — and it would read as confident and specific while being wrong.
// This is the one failure mode worth checking mechanically rather than by eye.
//
//   npm run verify -- data/run-<locationId>.json
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run verify -- data/run-<locationId>.json");
  process.exit(1);
}

const run = JSON.parse(readFileSync(file, "utf8"));

// The model reproduces the words faithfully but does not always preserve the
// original unicode punctuation, so compare on normalized text.
const normalize = (s) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, "-")
    .replace(/\s+/g, " ")
    .trim();

const transcripts = normalize(run.transcripts.map((t) => t.transcript).join("\n"));

const failures = [];
let checked = 0;

for (const pattern of run.analysis.issuePatterns) {
  for (const quote of pattern.evidence) {
    checked++;
    if (!transcripts.includes(normalize(quote))) {
      failures.push({ where: `issue "${pattern.title}"`, quote });
    }
  }
}

for (const testCase of run.baseline.cases) {
  for (const verdict of testCase.verdicts) {
    if (verdict.tag !== "observed") continue;
    checked++;
    if (!verdict.evidence) {
      failures.push({ where: `${testCase.id} "${verdict.criterion}"`, quote: "(no evidence given)" });
    } else if (!transcripts.includes(normalize(verdict.evidence))) {
      failures.push({ where: `${testCase.id} "${verdict.criterion}"`, quote: verdict.evidence });
    }
  }
}

console.log(`${checked - failures.length}/${checked} citations found verbatim in the transcripts`);

for (const f of failures) {
  console.log(`\n  NOT FOUND in ${f.where}\n    ${f.quote.slice(0, 160)}`);
}

process.exit(failures.length ? 1 : 0);
