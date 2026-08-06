// Tier 3: the two expensive steps. Prompts live directly above the function that
// sends them.
//
// These calls used to do the reading, the pattern-finding and the writing all at
// once, over the fifty most recent transcripts. The reading is now the
// labeller's and the pattern-finding is arithmetic, so what is left here is the
// part a model is genuinely better at than code: narrating what the numbers
// mean, and writing tests and configuration changes that follow from them.
import { complete } from "./model.js";
import { DIMENSION_IDS, ISSUE_TYPES, SEVERITIES } from "./framework.js";

// Sonnet first, Opus as a fallback.
//
// Splitting the work is what makes Opus unnecessary. The job here is writing
// over a pre-computed aggregate and ten transcripts, not detection across fifty
// — a tenth of the input, producing less output. Opus also flapped with
// overloaded_error repeatedly during development, losing whole runs, and costs
// roughly 1.7x Sonnet per output token, which dominates this workload.
//
// An earlier version of this comment claimed a measured Opus-over-Sonnet gap.
// Those were uncontrolled runs against different generated suites at different
// points in the pipeline's life — one Opus data point against two Sonnet ones,
// not a benchmark. ANTHROPIC_MODEL keeps the choice testable rather than baked
// in.
const SYNTHESIS_MODELS = process.env.ANTHROPIC_MODEL
  ? [process.env.ANTHROPIC_MODEL]
  : ["claude-sonnet-5", "claude-opus-5"];

// Sonnet 5 thinks adaptively by default, at `high` effort. That thinking is
// generated one token at a time like the rest of the output, so across three
// sequential calls it dominates the run — a measured 367s where the trimmed
// schemas alone predicted half that. `medium` is the documented equivalent of
// Sonnet 4.6 at `high`, which is more than this job needs now that the reading
// and the pattern-finding have been taken away from it.
//
// Kept as an override so the trade is measurable rather than assumed.
const SYNTHESIS_EFFORT = process.env.ANTHROPIC_EFFORT || "medium";

// Rendered into both prompts so the two passes judge the same configuration.
function describeAgent(agent) {
  return `Name: ${agent.name} (${agent.businessName})
Greeting: ${agent.welcomeMessage}
Voice: ${agent.voiceId} / ${agent.language}
Responsiveness: ${agent.responsiveness}
Max call duration: ${agent.maxCallDuration}s
Idle reminders: ${agent.idleReminders ? `every ${agent.idleReminderSeconds}s` : "off"}
Timezone: ${agent.timezone}
Working hours: ${agent.workingHours.length ? JSON.stringify(agent.workingHours) : "none configured"}
Actions available to the agent: ${agent.actions.length ? agent.actions.map((a) => a.name ?? a.type ?? JSON.stringify(a)).join(", ") : "none configured"}
Post-call workflows: ${agent.postCallWorkflows.length ? agent.postCallWorkflows.join(", ") : "none configured"}

## Prompt
${agent.prompt || "(empty)"}`;
}

/**
 * The sampled calls, each carrying why it was chosen.
 *
 * Saying why matters: the model is reading ten calls out of possibly thousands,
 * and without that it would reasonably infer these are the agent's calls rather
 * than its worst ones, and write frequencies that the aggregate has already
 * counted exactly.
 */
function describeSample(sample) {
  return sample
    .map(
      ({ call, label, why }) => `## Call ${call.callId} (${call.durationSec}s) — selected as ${why}${
        call.isTestCall ? "\nThis is a test call — the operator probing their own agent, not a customer." : ""
      }
Actions the agent actually triggered: ${call.actionsExecuted.length ? call.actionsExecuted.join(", ") : "none"}
Data the agent actually captured: ${Object.keys(call.dataCollected).length ? JSON.stringify(call.dataCollected) : "none"}
Transferred to a human: ${call.transferred ? "yes" : "no"}
Classified as: ${label.outcome} — ${label.reason}
Failed on: ${Object.entries(label.dimensions).filter(([, v]) => v === "fail").map(([d]) => d).join(", ") || "nothing"}

${call.transcript}`,
    )
    .join("\n\n");
}

/** The scores, as text, so the narrative is written against them rather than around them. */
function describeAggregate(agg) {
  const rows = agg.framework
    .map((d) =>
      d.score === null
        ? `- ${d.dimension}: not evaluated (${d.summary})`
        : `- ${d.dimension}: ${d.score}/100 (${d.status}) — failed ${d.callsAffected} of the ${d.exercised} calls that exercised it`,
    )
    .join("\n");

  const issues = Object.entries(agg.issueFrequency)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => `- ${type}: ${n} calls`)
    .join("\n");

  return `Calls labelled: ${agg.callsScored}${agg.testCalls ? ` (${agg.testCalls} of them test calls)` : ""}
Outcomes: ${agg.outcomes.success} success, ${agg.outcomes.failure} failure, ${agg.outcomes.missed_opportunity} missed opportunity

Framework scores, computed over every labelled call:
${rows}

Issue types present, counted over every labelled call:
${issues || "- none"}`;
}

const ANALYZE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["issuePatterns", "testCases"],
  properties: {
    issuePatterns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        // No frequency field. How often an issue occurs is already counted over
        // every call — asking for it back would invite a number contradicting
        // the one the Scorecard shows, from a model that saw ten calls.
        required: ["dimension", "type", "title", "severity", "evidence"],
        properties: {
          dimension: { type: "string", enum: DIMENSION_IDS },
          type: { type: "string", enum: ISSUE_TYPES },
          title: { type: "string" },
          severity: { type: "string", enum: SEVERITIES },
          evidence: {
            type: "array",
            items: { type: "string" },
            description: "Verbatim quotes from the sampled transcripts. Never paraphrase.",
          },
        },
      },
    },
    testCases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "type", "persona", "scenario", "successCriteria"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          type: { type: "string", enum: ["happy", "edge"] },
          persona: { type: "string" },
          scenario: { type: "string" },
          successCriteria: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const ANALYST_SYSTEM = `You audit Voice AI phone agents for a business.

You are given an agent's live configuration, a scorecard already computed across every call it
has ever taken, and the transcripts of a small number of calls chosen as the most revealing
examples. You explain what is going wrong and write a regression suite for it.

Rules you do not break:
- Every issue you report must be supported by a verbatim quote from one of the transcripts you
  were given. Copy the words exactly as they appear. If you cannot quote it, you may not
  report it.
- The scorecard is measured, not proposed. Do not contradict it, re-score it, or estimate how
  often anything happens — the counts are exact and you are seeing a deliberate sample. Your
  job is to say what the failures look like, not how many there are.
- File issues only under dimensions the scorecard shows as weak or failing. An issue under a
  strong dimension means you are reading the sample as if it were the whole record.
- Judge the agent against its own stated goal and configuration, not against an ideal agent.
- Do not invent problems to fill out the list. A well-handled call is a success.
- Calls marked as test calls are the operator probing their own agent, not customers. Behaviour
  that only appears under probing says less about customer experience than the same behaviour
  in a real call. Say so when a pattern rests only on test calls.`;

/**
 * Narrate the failures and generate the test suite.
 *
 * The framework scores and the per-call outcomes no longer come from here — they
 * are counted from labels over 100% of the calls. What this call adds is the
 * part a count cannot: what the failure actually looks like, quoted, and a suite
 * that would catch it coming back.
 */
export function analyze({ agent, aggregate, sample, usedModels }) {
  const prompt = `# Agent under review

${describeAgent(agent)}

# Scorecard — already measured across every call

${describeAggregate(aggregate)}

# Sampled transcripts

These ${sample.length} calls were selected from the ${aggregate.callsScored} labelled calls as the
most revealing examples of the weaknesses above, plus contrast. They are not a random sample and
not the most recent calls.

${describeSample(sample)}

# Your task

1. Explain the recurring issues behind the weak scores. Use only these types:
   ${ISSUE_TYPES.join(", ")}, and file each one under the single framework dimension that best
   explains it — from the dimensions the scorecard marks weak or failing. For each, give a
   specific title (not the type name), a severity, and verbatim quotes as evidence.

   Report an issue once. Two calls showing the same failure are one issue with two quotes.

2. Generate exactly 6 test cases for regression-testing this agent. Derive them from the issues
   you found — at least half should cover scenarios these transcripts actually exercised, so the
   results can be checked against real evidence. Include both happy-path and edge-case scenarios.

   Give each case a stable id (tc-1 … tc-6) and 3-5 success criteria. Each criterion must be a
   single checkable claim about the agent's behaviour, phrased as a requirement — for example
   "Collects the caller's email address before ending the call". Draw on: collecting required
   contact information, following the booking flow, staying on brand and polite, handling
   interruptions and objections, and avoiding unsupported claims.`;

  return complete({
    models: SYNTHESIS_MODELS,
    effort: SYNTHESIS_EFFORT,
    system: ANALYST_SYSTEM,
    prompt,
    schema: ANALYZE_SCHEMA,
    usedModels,
    // issuePatterns may legitimately be empty — an agent can have no weak
    // dimensions. The suite cannot: it is always six cases, and a run that
    // returned none would let the evaluator invent its own to score.
    validate: (r) => {
      if (r.testCases.length !== 6) return `${r.testCases.length} test cases, expected 6`;
      const short = r.testCases.find((tc) => !tc.successCriteria?.length);
      if (short) return `${short.id} has no success criteria`;
      return null;
    },
  });
}

// The first six are the categories the brief asks for. call_settings and
// follow_up are added because they map to fields this API actually exposes
// (working hours, timezone, idle reminders, post-call workflows) and the
// transcripts produce direct evidence for them.
const RECOMMENDATION_CATEGORIES = [
  "prompt",
  "temperature",
  "model",
  "actions",
  "knowledge_base",
  "guardrails",
  "call_settings",
  "follow_up",
];

// Output tokens are generated one at a time, so they set the wall clock; input is
// processed in parallel and barely matters. With structured outputs the schema
// decides how much gets written, which makes trimming it the one speed-up that
// costs no quality.
//
// So: criteria come back as an index into the list the model was handed, not
// copied out verbatim. A passing criterion returns no reason, because a passing
// criterion needs no justification. A predicted verdict returns no evidence,
// because by definition it has none.
const baselineVerdict = {
  type: "object",
  additionalProperties: false,
  required: ["criterionIndex", "pass", "tag"],
  properties: {
    criterionIndex: {
      type: "integer",
      description: "0-based position of the criterion in this test case's list.",
    },
    pass: { type: "boolean" },
    tag: { type: "string", enum: ["observed", "predicted"] },
    evidence: {
      type: "string",
      description:
        "A verbatim transcript quote. Include only for observed verdicts; omit entirely for predicted ones.",
    },
    reason: {
      type: "string",
      description: "Why it fails. Include only when pass is false; omit entirely when it passes.",
    },
  },
};

// The patched pass exists to produce a delta. It needs pass/fail to compute the
// score and a reason for the criteria that moved; the tag, the evidence and the
// criterion text are all already known from the baseline, and re-emitting them
// for thirty criteria was the single largest piece of wasted generation in the
// run.
const patchedVerdict = {
  type: "object",
  additionalProperties: false,
  required: ["criterionIndex", "pass"],
  properties: {
    criterionIndex: { type: "integer" },
    pass: { type: "boolean" },
    reason: {
      type: "string",
      description:
        "Only for criteria whose verdict changed from the baseline: what the pending changes fix. Omit otherwise.",
    },
  },
};

const caseResults = (verdict) => ({
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "verdicts"],
    properties: {
      id: { type: "string" },
      verdicts: { type: "array", items: verdict },
    },
  },
});

const EVALUATOR_SYSTEM = `You evaluate whether a Voice AI agent's configuration satisfies a
set of test criteria, and you are strict about the difference between what you measured and
what you inferred.

Every verdict carries a tag:
- "observed" — a real call in the transcripts already exercised this criterion. The evidence
  field must contain a verbatim quote from that transcript.
- "predicted" — no call exercised it. The verdict follows from a gap in the agent's
  configuration, and the evidence field must be omitted.

Tagging a verdict "observed" when you cannot quote a real transcript is the one error that
invalidates this entire report. When a criterion is only partly exercised by a real call, tag
it predicted. Prefer predicted whenever you are unsure.

Evidence is copied, never composed. Take one contiguous span of a single transcript, exactly as
it appears. Do not stitch together turns that were not next to each other, do not merge two
calls into one quote, and do not tidy up the wording — a quote that reads better than the
transcript is a quote that is checked against the transcript and fails.

Return every criterion by its index in the list you are given. Do not copy criterion text back —
it is already known, and reproducing it is time the user spends waiting.`;

/**
 * Evaluates the test suite against a configuration. Called twice: once for the
 * current config (with recommendations, which need the failures this pass
 * produces), and once for the patched config to measure the before/after delta.
 *
 * Patches are never applied by string surgery — the patched pass receives the
 * original prompt plus the patch list and evaluates as if they were applied.
 */
export function evaluate({
  agent,
  testCases,
  sample,
  issuePatterns,
  patches,
  configChanges,
  baselineCases,
  recommend,
  usedModels,
}) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: recommend ? ["cases", "recommendations", "patches"] : ["cases"],
    properties: {
      cases: caseResults(recommend ? baselineVerdict : patchedVerdict),
      ...(recommend && {
        recommendations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["category", "change", "rationale", "evidence", "criteriaExpectedToFix"],
            properties: {
              category: { type: "string", enum: RECOMMENDATION_CATEGORIES },
              change: { type: "string" },
              rationale: { type: "string" },
              evidence: { type: "string" },
              criteriaExpectedToFix: { type: "array", items: { type: "string" } },
            },
          },
        },
        patches: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["section", "operation", "text", "reason"],
            properties: {
              section: { type: "string" },
              operation: { type: "string", enum: ["add", "replace"] },
              text: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
      }),
    },
  };

  const suite = testCases
    .map(
      (tc) => `## ${tc.id} — ${tc.name} (${tc.type} path)
Persona: ${tc.persona}
Scenario: ${tc.scenario}
Criteria:
${tc.successCriteria.map((c, i) => `[${i}] ${c}`).join("\n")}`,
    )
    .join("\n\n");

  // The patched pass is told what the baseline concluded, so it can return a
  // reason only where its verdict differs — and so it is anchored to the same
  // reading of the transcripts rather than re-deriving one.
  const baselineSummary = baselineCases
    ?.map((c) => {
      const failing = c.verdicts.filter((v) => !v.pass).map((v) => v.criterionIndex);
      return `${c.id}: currently failing ${failing.length ? failing.map((i) => `[${i}]`).join(" ") : "nothing"}`;
    })
    .join("\n");

  const prompt = `# Agent configuration under test

${describeAgent(agent)}
${
  patches
    ? `
## Pending prompt patches — evaluate as if these are already applied
${patches.map((p) => `### ${p.section} (${p.operation})\n${p.text}`).join("\n\n")}
`
    : ""
}${
    configChanges?.length
      ? `
## Pending configuration changes — evaluate as if these are already applied
${configChanges.map((c) => `- [${c.category}] ${c.change}`).join("\n")}

These are changes to the agent's setup rather than its wording — a wired action, a
configured workflow, adjusted call settings, added knowledge base content. Judge the
criteria they affect against the agent as it would behave with them in place. An agent
that has been given a booking action can complete a booking; one that has only been told
to stop claiming it booked something cannot.
`
      : ""
  }
# Real call transcripts

${describeSample(sample)}

# Test cases

${suite}

# Your task

For every test case, return a verdict on every one of its criteria, identified by its index.
Judge against the configuration above${patches || configChanges?.length ? " with the pending changes applied" : ""}.${
    baselineSummary
      ? `

The same suite has already been scored against the agent as it stands today:

${baselineSummary}

Return pass or fail for every criterion. Give a reason only for the ones whose verdict differs
from that baseline, saying what the pending changes fix. Everything else is already recorded.`
      : `
Tag each verdict observed or predicted as defined in your instructions. Give a reason only for
the criteria that fail.`
  }${
    recommend
      ? `

Then recommend configuration changes that would fix the failures.

Detected issue patterns, with how often each occurs across every call on record:
${issuePatterns.map((p) => `- [${p.severity}] ${p.title} (${p.frequency} of ${p.coverage} calls)`).join("\n")}

Recommend only where the evidence supports it. Available categories are
${RECOMMENDATION_CATEGORIES.join(", ")} — a category with nothing behind it must be left out
entirely rather than filled with a generic suggestion. Each recommendation states the change,
why it follows from the evidence, the evidence itself, and which criteria it should flip.

Choose the category by what the user has to change, not by where the text ends up:

- guardrails — rules that constrain or stop the agent: refusal rules, no-guarantees and
  no-unsupported-claims rules, persona locks, escalation and transfer rules, what to do on
  unclear input. File these under guardrails even when they are delivered as prompt text.
- prompt — the call script itself: what to ask, in what order, how to open and close.
- knowledge_base — the agent needs facts it does not have. Anything it was asked and could
  not answer from configuration, or answered by improvising, belongs here.
- actions, call_settings, follow_up — a configuration field must change.
- temperature, model — recommend when tone is inconsistent across calls, or when reasoning
  fails in a way no instruction would fix.

Model, temperature, and knowledge base content are configured in the HighLevel UI and are not
readable through this API. That does not make them out of scope: recommend them when the
evidence warrants, and say in the rationale that the change is applied in the UI rather than
in configuration shown above.

Finally, express the prompt changes as patches. Each patch names the section it applies to,
whether it adds or replaces, the exact text, and the reason. Patches are shown to the user as
the before/after diff, so the text must be ready to paste into the agent's configuration.`
      : ""
  }`;

  return complete({
    models: SYNTHESIS_MODELS,
    effort: SYNTHESIS_EFFORT,
    system: EVALUATOR_SYSTEM,
    prompt,
    schema,
    usedModels,
    // Every case must come back with a verdict on every criterion, exactly once.
    // Indices make a short reply cheap to detect and a duplicated one impossible
    // to miss — where copied-back criterion text used to make both look like
    // near-matches.
    validate: (r) => {
      if (r.cases.length !== testCases.length) {
        return `${r.cases.length} results for ${testCases.length} test cases`;
      }
      for (const tc of testCases) {
        const scored = r.cases.find((c) => c.id === tc.id);
        if (!scored) return `no result for ${tc.id}`;

        const seen = new Set(scored.verdicts.map((v) => v.criterionIndex));
        if (seen.size !== scored.verdicts.length) return `${tc.id}: a criterion was scored twice`;

        const missing = tc.successCriteria
          .map((_, i) => i)
          .filter((i) => !seen.has(i));
        if (missing.length) return `${tc.id}: no verdict on criteria ${missing.join(", ")}`;
      }
      return null;
    },
  });
}
