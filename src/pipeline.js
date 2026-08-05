import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

import { getAgent, listCallLogs } from "./ghl.js";
import { analyze, evaluate } from "./ai.js";

// Runs are stored per location and agent: one deployment serves many installs,
// and a location may have several Voice AI agents whose results must not be
// confused with each other.
const runFile = (locationId, agentId) => `data/run-${locationId}-${agentId}.json`;

export function readRun(locationId, agentId) {
  const file = runFile(locationId, agentId);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function score(cases) {
  const verdicts = cases.flatMap((c) => c.verdicts);
  return { passed: verdicts.filter((v) => v.pass).length, total: verdicts.length };
}

/** Criteria that fail on the current configuration and pass on the patched one. */
function flippedCriteria(baseline, patched, testCases) {
  const nameOf = (id) => testCases.find((tc) => tc.id === id)?.name ?? id;

  return baseline.flatMap((before) => {
    const after = patched.find((c) => c.id === before.id);
    if (!after) return [];

    return before.verdicts
      .filter((v) => !v.pass)
      .filter((v) => after.verdicts.find((a) => a.criterion === v.criterion)?.pass)
      .map((v) => ({ caseId: before.id, caseName: nameOf(before.id), criterion: v.criterion }));
  });
}

/**
 * Ingest transcripts, find failure patterns, generate a test suite, score it against
 * the current configuration, recommend changes, then score the same suite again with
 * those changes applied. Three LLM calls; the second and third share one function.
 */
export async function run(auth, agentId) {
  const [agent, transcripts] = await Promise.all([
    getAgent(auth, agentId),
    listCallLogs(auth, agentId),
  ]);

  if (!transcripts.length) {
    throw new Error(
      `No Voice AI transcripts found for agent ${agentId}. Run a few test calls from the agent's Test panel in HighLevel first.`,
    );
  }

  const { callOutcomes, framework, issuePatterns, testCases } = await analyze({
    agent,
    transcripts,
  });

  const baseline = await evaluate({
    agent,
    testCases,
    transcripts,
    issuePatterns,
    recommend: true,
  });

  // Prompt and guardrail recommendations are delivered as prompt patches; the rest
  // are changes to the agent's setup. Both have to reach the second evaluation, or
  // the measured improvement would only ever reflect rewording — which is the thing
  // this tool exists to move past.
  const configChanges = baseline.recommendations.filter(
    (r) => !["prompt", "guardrails"].includes(r.category),
  );

  const patched = await evaluate({
    agent,
    testCases,
    transcripts,
    patches: baseline.patches,
    configChanges,
  });

  const result = {
    generatedAt: new Date().toISOString(),
    agent,
    transcripts,
    analysis: { callOutcomes, framework, issuePatterns },
    testCases,
    baseline: { cases: baseline.cases, score: score(baseline.cases) },
    recommendations: baseline.recommendations,
    patches: baseline.patches,
    configChanges,
    patched: { cases: patched.cases, score: score(patched.cases) },
    flipped: flippedCriteria(baseline.cases, patched.cases, testCases),
  };

  mkdirSync("data", { recursive: true });
  writeFileSync(runFile(auth.locationId, agentId), JSON.stringify(result, null, 2));

  return result;
}
