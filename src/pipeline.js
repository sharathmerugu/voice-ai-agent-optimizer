import * as store from "./store.js";
import { getAgent, listCallLogs } from "./ghl.js";
import { labelAll } from "./labels.js";
import { aggregate } from "./aggregate.js";
import { selectSample } from "./sample.js";
import { analyze, evaluate } from "./ai.js";
import { corpusOf, cites } from "./cite.js";

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
//
// Version 3 adds `citations`, and with it the guarantee that every quote in the
// run has been traced to a transcript. A version 2 run carries quotes that were
// never checked — one of them, in the run this was built from, altered the
// agent's words — so those are recomputed rather than shown under a promise
// they do not meet.
const RUN_VERSION = 3;

// How many calls one run will read. Below this, the analysis covers every call
// the agent has taken; above it, the newest N — and the UI says which, so a
// window is never presented as the whole record.
//
// Note what this does not do: `listCallLogs` pages newest-first, so the window
// slides forward as calls arrive rather than crawling backwards. Calls beyond
// the cap are never read at all, and re-running does not change that. Raising
// the cap is the only way to reach further back today; backfilling the older
// calls in the background is the obvious next step and is not built.
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

/**
 * A quote checker bound to one run's sampled transcripts.
 *
 * Every quote the user sees is a claim that the agent, or the caller, said
 * exactly this. The models are instructed to copy rather than compose, and
 * mostly do — but "mostly" is not a property a report can be built on, and a
 * near-miss is the worst kind: it reads as precise while being false. The run
 * that prompted this changed the agent's "try a different week" into "try a
 * different day" and presented it as a measurement.
 *
 * So the instruction is backed by a check. `stats` is stored on the run, which
 * turns the guarantee into something the reader can see rather than take on
 * trust.
 */
function checker(sample) {
  const corpus = corpusOf(sample);
  const stats = { checked: 0, rejected: 0, issuesDropped: 0 };

  const traceable = (quote) => {
    stats.checked++;
    const ok = Boolean(quote) && cites(corpus, quote);
    if (!ok) stats.rejected++;
    return ok;
  };

  return { stats, traceable };
}

/**
 * An issue keeps only the quotes that are real, and an issue with none left is
 * not reported at all — the analyst's own rule is that what cannot be quoted may
 * not be claimed, and this is that rule enforced rather than requested.
 */
function gateIssues(issues, { traceable, stats }) {
  const kept = issues
    .map((issue) => ({ ...issue, evidence: issue.evidence.filter(traceable) }))
    .filter((issue) => issue.evidence.length);

  stats.issuesDropped = issues.length - kept.length;
  return kept;
}

/**
 * An `observed` verdict that cannot be quoted is demoted to `predicted`.
 *
 * Not deleted: the verdict itself may well be right, and dropping it would leave
 * a criterion unscored and the suite total moving between runs for reasons that
 * have nothing to do with the agent. What it loses is the claim to have been
 * measured — which is exactly the claim the missing quote fails to support.
 */
function gateCases(cases, { traceable }) {
  return cases.map((c) => ({
    ...c,
    verdicts: c.verdicts.map((v) =>
      v.tag === "observed" && !traceable(v.evidence)
        ? { ...v, tag: "predicted", evidence: undefined }
        : v,
    ),
  }));
}

/**
 * A recommendation survives an unquotable citation, minus the citation.
 *
 * Its rationale is an argument from the configuration and the scorecard, both of
 * which stand on their own. Only the quote is withdrawn.
 */
function gateRecommendations(recommendations, { traceable }) {
  return recommendations.map((r) =>
    r.evidence && !traceable(r.evidence) ? { ...r, evidence: undefined } : r,
  );
}

/**
 * Criteria whose verdict moved between the two evaluations — in both directions.
 *
 * Reporting only the improvements would make the before/after screen structurally
 * incapable of delivering bad news, which is the same as making it worthless: a
 * measurement that can only come out one way is not a measurement. A patch that
 * fixes four criteria and breaks one is a real result and the user is entitled to
 * decide what to do about it.
 *
 * The score already reflects a regression — it is a count over the same verdicts
 * — so this is about what the page says, not what it computes.
 */
function movedCriteria(baseline, patched, testCases) {
  const nameOf = (id) => testCases.find((tc) => tc.id === id)?.name ?? id;

  const moved = (was, becomes) =>
    baseline.flatMap((before) => {
      const after = patched.find((c) => c.id === before.id);
      if (!after) return [];

      return before.verdicts
        .filter((v) => v.pass === was)
        .flatMap((v) => {
          const now = after.verdicts.find((a) => a.criterionIndex === v.criterionIndex);
          if (now?.pass !== becomes) return [];

          return {
            caseId: before.id,
            caseName: nameOf(before.id),
            criterion: v.criterion,
            // The patched pass is asked for a reason only where its verdict
            // differs from the baseline, which is exactly this set.
            reason: now.reason ?? "",
          };
        });
    });

  return { flipped: moved(false, true), regressed: moved(true, false) };
}

/**
 * Label every call, count what the labels say, choose the calls worth reading
 * closely, synthesize, then check every quote the synthesis produced against the
 * transcripts it claims to be quoting.
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

  // Bound to the sample, because the sample is what the synthesizer was shown
  // and therefore the only thing it can honestly be quoting.
  const citations = checker(sample);

  const issues = gateIssues(
    issuePatterns.map((p) => ({
      ...p,
      frequency: failuresPerDimension.get(p.dimension) ?? 0,
      coverage: agg.callsScored,
    })),
    citations,
  );

  const baseline = await evaluate({
    agent,
    testCases,
    sample,
    issuePatterns: issues,
    recommend: true,
    usedModels,
  });
  const baselineCases = gateCases(hydrate(baseline.cases, testCases), citations);
  const recommendations = gateRecommendations(baseline.recommendations, citations);

  // Prompt and guardrail recommendations are delivered as prompt patches; most of
  // the rest are changes to the agent's setup. Both have to reach the second
  // evaluation, or the measured improvement would only ever reflect rewording —
  // which is the thing this tool exists to move past.
  //
  // Model and temperature are held back, and the distinction is the whole reason
  // this filter is a list rather than a negation. A wired booking action or a
  // populated knowledge base changes what the agent can do, and an evaluator can
  // reason about that from the configuration. "Lower the temperature" changes how
  // it behaves in a way nobody can predict without running it — so scoring the
  // patched configuration as if the change had already worked would be inventing
  // the improvement this tool exists to measure. They are still recommended, and
  // the UI says they are not counted in the after score.
  const UNSCORABLE = ["model", "temperature"];

  const configChanges = recommendations.filter(
    (r) => !["prompt", "guardrails", ...UNSCORABLE].includes(r.category),
  );
  const unscoredChanges = recommendations.filter((r) => UNSCORABLE.includes(r.category));

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

    // How much of the report was checkable, and how much of it was thrown away
    // for failing the check. Shown in the UI: a report that says every quote in
    // it was traced back to a transcript has to say who counted.
    citations: citations.stats,

    aggregate: agg,
    // Only the calls the strong model read are stored. Keeping all of them would
    // put a megabyte of transcript in every cached run to no purpose — the
    // aggregate already carries what the other calls contributed.
    sample,
    issues,
    testCases,
    baseline: { cases: baselineCases, score: score(baselineCases) },
    recommendations,
    patches: baseline.patches,
    configChanges,
    unscoredChanges,
    patched: { cases: patchedCases, score: score(patchedCases) },
    ...movedCriteria(baselineCases, patchedCases, testCases),
  };

  await store.set(runKey(auth.locationId, agentId), result);

  return result;
}
