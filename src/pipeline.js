import * as store from "./store.js";
import { getAgent, listCallLogs } from "./ghl.js";
import { analyze, evaluate } from "./ai.js";

// Runs are keyed per location and agent: one deployment serves many installs, and
// a location may have several Voice AI agents whose results must not be confused
// with each other.
//
// This is a cache, not a record — an analysis costs three model calls and several
// minutes, so it is computed once and served until the user asks for a fresh one.
const runKey = (locationId, agentId) => `run:${locationId}:${agentId}`;

export function readRun(locationId, agentId) {
  return store.get(runKey(locationId, agentId));
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
  const [agent, { transcripts, totalCalls }] = await Promise.all([
    getAgent(auth, agentId),
    listCallLogs(auth, agentId),
  ]);

  if (!transcripts.length) {
    throw new Error(
      `No Voice AI transcripts found for agent ${agentId}. Run a few test calls from the agent's Test panel in HighLevel first.`,
    );
  }

  // Collects which models actually answered — a sustained outage on the preferred
  // model degrades the analysis rather than failing it, and the run has to say so.
  const usedModels = new Set();

  const { callOutcomes, framework, issuePatterns, testCases } = await analyze({
    agent,
    transcripts,
    usedModels,
  });

  const baseline = await evaluate({
    agent,
    testCases,
    transcripts,
    issuePatterns,
    recommend: true,
    usedModels,
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
    usedModels,
  });

  const result = {
    generatedAt: new Date().toISOString(),
    // Which model produced this. Scores are not comparable across models, so a
    // cached run has to say what made it rather than leaving it to be inferred.
    model: [...usedModels].join(" + "),
    agent,
    transcripts,
    // How many calls this agent has taken in total, against the window analyzed.
    // They differ on a busy agent, and the UI says so rather than implying the
    // analysis covered everything.
    totalCalls,
    analysis: { callOutcomes, framework, issuePatterns },
    testCases,
    baseline: { cases: baseline.cases, score: score(baseline.cases) },
    recommendations: baseline.recommendations,
    patches: baseline.patches,
    configChanges,
    patched: { cases: patched.cases, score: score(patched.cases) },
    flipped: flippedCriteria(baseline.cases, patched.cases, testCases),
  };

  await store.set(runKey(auth.locationId, agentId), result);

  return result;
}
