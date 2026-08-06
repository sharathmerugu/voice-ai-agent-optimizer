import * as store from "./store.js";
import { getAgent, listCallLogs } from "./ghl.js";
import { labelAll } from "./labels.js";
import { aggregate } from "./aggregate.js";
import { selectSample } from "./sample.js";
import { analyze, evaluate } from "./ai.js";

// Runs are keyed per location and agent: one deployment serves many installs, and
// a location may have several Voice AI agents whose results must not be confused
// with each other.
//
// This is a cache, not a record — synthesis costs three model calls and minutes,
// so it is computed once and served until the user asks for a fresh one. Note
// that labels are cached separately and far more aggressively: throwing away a
// run costs one synthesis, while throwing away a label costs it forever.
const runKey = (locationId, agentId) => `run:${locationId}:${agentId}`;

// Bumped whenever the shape of a stored run changes. A cached run from an older
// version is treated as absent and recomputed, rather than handed to a UI that
// expects fields it does not carry.
//
// This matters on deploy, not in development: the runs already in Redis were
// written by the design that scored the fifty most recent calls, and they have
// no `coverage` or `aggregate` at all. Serving one to the current page would
// throw on the first render, for every user with a cached analysis.
const RUN_VERSION = 2;

// A first run on a very large account is capped, and the UI says so. This is a
// partial census rather than a biased sample — every one of these calls is
// labelled and counted, and because labels are permanent the cap is the only
// thing standing between a 10,000-call account and a complete picture.
const MAX_CALLS = Number(process.env.ANALYSIS_MAX_CALLS) || 500;

export async function readRun(locationId, agentId) {
  const run = await store.get(runKey(locationId, agentId));
  return run?.v === RUN_VERSION ? run : null;
}

function score(cases) {
  const verdicts = cases.flatMap((c) => c.verdicts);
  return { passed: verdicts.filter((v) => v.pass).length, total: verdicts.length };
}

/**
 * Put the criterion text back on the verdicts.
 *
 * The model returns an index into a list it was handed, because copying thirty
 * criteria back verbatim in each of two passes was pure generation time. The
 * text is reattached here so everything downstream — the UI, verify.js, the
 * stored run — reads as if it had never left.
 */
function hydrate(cases, testCases) {
  return cases.map((c) => {
    const criteria = testCases.find((tc) => tc.id === c.id)?.successCriteria ?? [];
    return {
      ...c,
      verdicts: c.verdicts
        .slice()
        .sort((a, b) => a.criterionIndex - b.criterionIndex)
        .map((v) => ({ ...v, criterion: criteria[v.criterionIndex] ?? `criterion ${v.criterionIndex}` })),
    };
  });
}

/** Criteria that fail on the current configuration and pass on the patched one. */
function flippedCriteria(baseline, patched, testCases) {
  const nameOf = (id) => testCases.find((tc) => tc.id === id)?.name ?? id;

  return baseline.flatMap((before) => {
    const after = patched.find((c) => c.id === before.id);
    if (!after) return [];

    return before.verdicts
      .filter((v) => !v.pass)
      .filter((v) => after.verdicts.find((a) => a.criterionIndex === v.criterionIndex)?.pass)
      .map((v) => ({ caseId: before.id, caseName: nameOf(before.id), criterion: v.criterion }));
  });
}

/**
 * Label every call, count what the labels say, choose the calls worth reading
 * closely, then synthesize.
 *
 * The expensive reasoning no longer scales with the corpus: labelling is once
 * per call ever, aggregation is arithmetic, and synthesis sees ten transcripts
 * whether the agent has taken twenty calls or twenty thousand.
 *
 * `onProgress` is called as labelling advances. It is the only part of the run
 * with an observable middle, which is what makes an honest progress figure
 * possible at all.
 */
export async function run(auth, agentId, { onProgress } = {}) {
  const [agent, { transcripts: calls, totalCalls }] = await Promise.all([
    getAgent(auth, agentId),
    listCallLogs(auth, agentId, MAX_CALLS),
  ]);

  if (!calls.length) {
    throw new Error(
      `No Voice AI transcripts found for agent ${agentId}. Run a few test calls from the agent's Test panel in HighLevel first.`,
    );
  }

  const { labels, labelled, fromCache, failures } = await labelAll(auth, agent, calls, {
    onProgress,
  });

  if (!labels.length) {
    throw new Error(
      "Every call failed to label. This is usually a temporary problem with the analysis service — try again shortly.",
    );
  }

  const agg = aggregate(labels);
  const sample = selectSample(labels, calls, { weakest: agg.weakest });

  // Collects which models actually answered — a sustained outage on the preferred
  // model degrades the analysis rather than failing it, and the run has to say so.
  const usedModels = new Set();

  const { issuePatterns, testCases } = await analyze({ agent, aggregate: agg, sample, usedModels });

  // Frequency comes from the count over every labelled call, never from the
  // model — it read ten transcripts and would be guessing. This is the join
  // between the narrative and the census.
  //
  // The join is on the dimension rather than the issue type, because the two
  // are counted by different readers. The labeller tags a call with issue types
  // from its own reading; the synthesizer picks a type for the pattern from ten
  // transcripts. They disagree often enough that joining on type produced
  // issues reported as occurring in zero calls — narrated by one model, unseen
  // by the other. A dimension's failure count is the same arithmetic the
  // Scorecard shows, and every issue is filed under exactly one dimension.
  const failuresPerDimension = new Map(agg.framework.map((d) => [d.dimension, d.callsAffected]));

  const issues = issuePatterns.map((p) => ({
    ...p,
    frequency: failuresPerDimension.get(p.dimension) ?? 0,
    coverage: agg.callsScored,
  }));

  const baseline = await evaluate({
    agent,
    testCases,
    sample,
    issuePatterns: issues,
    recommend: true,
    usedModels,
  });
  const baselineCases = hydrate(baseline.cases, testCases);

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
    sample,
    patches: baseline.patches,
    configChanges,
    baselineCases,
    usedModels,
  });
  const patchedCases = hydrate(patched.cases, testCases);

  const result = {
    v: RUN_VERSION,
    generatedAt: new Date().toISOString(),
    // Which model produced this. Scores are not comparable across models, so a
    // cached run has to say what made it rather than leaving it to be inferred.
    model: [...usedModels].join(" + "),
    agent,

    // What the numbers actually cover. The old design showed figures over the
    // fifty most recent calls and let them read as figures about the agent; this
    // block exists so the UI can never do that again.
    coverage: {
      totalCalls,
      callsScored: agg.callsScored,
      // The once-only invariant, made visible rather than assumed. `labelled`
      // non-zero on an account where nothing has changed means something is
      // wrong with the cache.
      labelled,
      fromCache,
      failedToLabel: failures.length,
      capped: totalCalls > calls.length,
    },

    aggregate: agg,
    // Only the calls the strong model read are stored. Keeping all of them would
    // put a megabyte of transcript in every cached run to no purpose — the
    // aggregate already carries what the other calls contributed.
    sample,
    issues,
    testCases,
    baseline: { cases: baselineCases, score: score(baselineCases) },
    recommendations: baseline.recommendations,
    patches: baseline.patches,
    configChanges,
    patched: { cases: patchedCases, score: score(patchedCases) },
    flipped: flippedCriteria(baselineCases, patchedCases, testCases),
  };

  await store.set(runKey(auth.locationId, agentId), result);

  return result;
}
