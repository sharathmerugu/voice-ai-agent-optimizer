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

// Evidence may cite a transcript, or a recorded field — four framework dimensions
// are judged from what the call actually did rather than what it said. Both are
// checkable; both are included here.
const corpus = normalize(
  run.transcripts
    .map(
      (t) =>
        `${t.transcript}\n` +
        `Actions the agent actually triggered: ${t.actionsExecuted.length ? t.actionsExecuted.join(", ") : "none"}\n` +
        `Data the agent actually captured: ${Object.keys(t.dataCollected).length ? JSON.stringify(t.dataCollected) : "none"}\n` +
        `Transferred to a human: ${t.transferred ? "yes" : "no"}`,
    )
    .join("\n"),
);

// A citation may elide between two passages. Each fragment still has to be real.
const fragments = (quote) =>
  quote
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map(normalize)
    .filter((f) => f.length > 12);

const cites = (quote) => {
  const parts = fragments(quote);
  return parts.length ? parts.every((p) => corpus.includes(p)) : corpus.includes(normalize(quote));
};

const failures = [];
let checked = 0;

for (const pattern of run.analysis.issuePatterns) {
  for (const quote of pattern.evidence) {
    checked++;
    if (!cites(quote)) {
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
    } else if (!cites(verdict.evidence)) {
      failures.push({ where: `${testCase.id} "${verdict.criterion}"`, quote: verdict.evidence });
    }
  }
}

console.log(`${checked - failures.length}/${checked} citations traced to the call record`);

for (const f of failures) {
  console.log(`\n  NOT FOUND in ${f.where}\n    ${f.quote.slice(0, 160)}`);
}

// The framework is only useful if its scores agree with the evidence beneath them. A
// twelve-dimension rubric invites plausible-sounding numbers, so the relationship between
// a dimension and its issues is checked rather than trusted.
const DIMENSIONS = [
  "prompt_adherence",
  "intent_recognition",
  "task_completion",
  "conversation_control",
  "loop_avoidance",
  "tool_execution",
  "knowledge_grounding",
  "data_capture",
  "routing_escalation",
  "call_completion",
  "responsiveness",
  "resolution",
];

const inconsistencies = [];

if (!run.analysis.framework) {
  inconsistencies.push("run has no framework — it predates the scorecard");
} else {
  const scored = new Map(run.analysis.framework.map((d) => [d.dimension, d]));

  for (const dimension of DIMENSIONS) {
    if (!scored.has(dimension)) inconsistencies.push(`${dimension}: not scored`);
  }
  for (const d of run.analysis.framework) {
    if (!DIMENSIONS.includes(d.dimension)) inconsistencies.push(`${d.dimension}: not a dimension`);
  }
  if (run.analysis.framework.length !== new Set(run.analysis.framework.map((d) => d.dimension)).size) {
    inconsistencies.push("a dimension is scored more than once");
  }

  for (const [dimension, d] of scored) {
    const issues = run.analysis.issuePatterns.filter((p) => p.dimension === dimension);

    if (d.status === "strong" && issues.some((p) => p.severity === "high")) {
      inconsistencies.push(`${dimension}: scored strong while carrying a high-severity issue`);
    }
    if (d.callsAffected > 0 && !issues.length) {
      inconsistencies.push(`${dimension}: ${d.callsAffected} calls affected but no issue filed`);
    }
    if (d.status === "not_evaluated" && d.score !== null) {
      inconsistencies.push(`${dimension}: not_evaluated but carries a score`);
    }
  }

  for (const p of run.analysis.issuePatterns) {
    if (!DIMENSIONS.includes(p.dimension)) {
      inconsistencies.push(`issue "${p.title.slice(0, 40)}": dimension ${p.dimension} is not valid`);
    }
  }
}

console.log(
  inconsistencies.length
    ? `${inconsistencies.length} framework inconsistencies`
    : "framework consistent with the issues beneath it",
);
for (const i of inconsistencies) console.log(`  ${i}`);

process.exit(failures.length || inconsistencies.length ? 1 : 0);
