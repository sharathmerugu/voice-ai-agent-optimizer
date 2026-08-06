// Checks a stored run against itself.
//
// Three things can go wrong in a way that reads as confident and specific while
// being false, so all three are checked mechanically rather than by eye:
//
//   1. A citation that does not appear in the transcript it claims to quote.
//   2. A framework score that disagrees with the issues filed beneath it.
//   3. A narrative that describes problems the census says are not there — the
//      failure mode created by writing from a sample and counting from the whole,
//      which is the shape of this system.
//
//   npm run verify -- data/kv/run__<locationId>__<agentId>.json
//
// The pipeline now runs the same citation check before storing a run, so (1)
// should come back clean on anything written by the current version. This stays
// as an external audit rather than being deleted with the bug it caught: it
// re-derives the corpus from the stored run and makes no assumption that the
// pipeline did its job, and it is the only check that covers a run written by an
// older version.
import { readFileSync } from "node:fs";
import { DIMENSION_IDS, isWeak } from "./framework.js";
import { corpusOf, cites as citesIn } from "./cite.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run verify -- data/kv/run__<locationId>__<agentId>.json");
  process.exit(1);
}

const run = JSON.parse(readFileSync(file, "utf8"));

const corpus = corpusOf(run.sample);
const cites = (quote) => citesIn(corpus, quote);

const failures = [];
let checked = 0;

for (const issue of run.issues) {
  for (const quote of issue.evidence) {
    checked++;
    if (!cites(quote)) failures.push({ where: `issue "${issue.title}"`, quote });
  }
}

for (const testCase of run.baseline.cases) {
  for (const verdict of testCase.verdicts) {
    if (verdict.tag !== "observed") continue;
    checked++;
    if (!verdict.evidence) {
      failures.push({ where: `${testCase.id} "${verdict.criterion}"`, quote: "(no evidence given)" });
    } else if (!cites(verdict.evidence)) {
      failures.push({ where: `${testCase.id} "${verdict.criterion}"`, quote: verdict.evidence });
    }
  }
}

console.log(`${checked - failures.length}/${checked} citations traced to the call record`);

for (const f of failures) {
  console.log(`\n  NOT FOUND in ${f.where}\n    ${f.quote.slice(0, 160)}`);
}

// The framework is only useful if its scores agree with the evidence beneath them.
const inconsistencies = [];
const framework = run.aggregate?.framework;

if (!framework) {
  inconsistencies.push("run has no aggregate — it predates the label-and-count pipeline");
} else {
  const scored = new Map(framework.map((d) => [d.dimension, d]));

  for (const dimension of DIMENSION_IDS) {
    if (!scored.has(dimension)) inconsistencies.push(`${dimension}: not scored`);
  }
  for (const d of framework) {
    if (!DIMENSION_IDS.includes(d.dimension)) inconsistencies.push(`${d.dimension}: not a dimension`);
  }
  if (framework.length !== scored.size) {
    inconsistencies.push("a dimension is scored more than once");
  }

  for (const [dimension, d] of scored) {
    const issues = run.issues.filter((p) => p.dimension === dimension);

    if (d.status === "strong" && issues.some((p) => p.severity === "high")) {
      inconsistencies.push(`${dimension}: scored strong while carrying a high-severity issue`);
    }
    if (d.status === "not_evaluated" && d.score !== null) {
      inconsistencies.push(`${dimension}: not_evaluated but carries a score`);
    }
    // The score is a pass rate over the calls that exercised the dimension, so
    // these are two views of the same arithmetic. If they disagree, the counting
    // is wrong, not the wording.
    if (d.exercised && Math.round((100 * (d.exercised - d.callsAffected)) / d.exercised) !== d.score) {
      inconsistencies.push(
        `${dimension}: score ${d.score} does not follow from ${d.callsAffected} failures in ${d.exercised} calls`,
      );
    }

    // The narrative is written from ~10 transcripts; the score is counted over
    // every call. This is where those two can drift apart, so an issue filed
    // under a dimension the census says is fine is caught here rather than read
    // past. The reverse is allowed: a weak dimension may have no narrated issue
    // if the sample happened not to illustrate it well.
    if (issues.length && !isWeak(d.status) && d.status !== "not_evaluated") {
      inconsistencies.push(
        `${dimension}: scored ${d.status} across ${d.exercised} calls but the deep dive files ${issues.length} issue(s) under it`,
      );
    }
  }

  for (const p of run.issues) {
    if (!DIMENSION_IDS.includes(p.dimension)) {
      inconsistencies.push(`issue "${p.title.slice(0, 40)}": dimension ${p.dimension} is not valid`);
    }
    // Frequency is counted in code from every label, so a zero means the
    // synthesizer named a failure type the census never saw.
    if (!p.frequency) {
      inconsistencies.push(`issue "${p.title.slice(0, 40)}": narrated but counted in 0 calls`);
    }
  }
}

console.log(
  inconsistencies.length
    ? `${inconsistencies.length} framework inconsistencies`
    : "framework consistent with the issues beneath it",
);
for (const i of inconsistencies) console.log(`  ${i}`);

// The once-only invariant, restated as a check. On a re-run of an unchanged
// account this must be zero; the plan's own verification hangs on it.
const { labelled, fromCache, callsScored, failedToLabel } = run.coverage ?? {};
console.log(
  `labelled ${labelled} of ${callsScored} calls this run, ${fromCache} already on file` +
    (failedToLabel ? `, ${failedToLabel} unreadable` : ""),
);

process.exit(failures.length || inconsistencies.length ? 1 : 0);
