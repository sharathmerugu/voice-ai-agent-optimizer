// Tier 1: read every call exactly once, ever.
//
// This is the load-bearing property of the whole design. A transcript is
// immutable — call 6a709547 yields the same reading today, next month, forever —
// so it is read by a cheap model once and the result cached with no expiry.
// Everything downstream is arithmetic over those readings, which is what lets
// the scores cover 100% of an agent's calls instead of the most recent fifty.
//
// The consequence at scale: an account with 10,000 calls pays for labelling
// once. The next day's 40 new calls cost 40 labels and nothing else.
import * as store from "./store.js";
import { complete } from "./model.js";
import { ISSUE_TYPES, READ_DIMENSIONS, VERDICTS } from "./framework.js";

// Classification over a single transcript — did the caller get an answer, did
// the agent repeat itself, did it stay on script. Small models are reliable at
// this; the hard judgement stays in synthesis.
//
// Haiku's 200K window is not a constraint: it sees one transcript per request,
// and a transcript runs about 6 tokens per second of call against a 900s cap —
// roughly 5,400 tokens at the very longest, under 3% of the window.
const LABEL_MODELS = process.env.LABEL_MODEL
  ? [process.env.LABEL_MODEL]
  : ["claude-haiku-4-5-20251001", "claude-sonnet-5"];

// Bumped whenever the shape or meaning of a stored label changes. A label from
// an older version is treated as a miss rather than being read with the wrong
// meaning — silently mixing two label vocabularies in one aggregate would
// produce numbers that look fine and are wrong.
const LABEL_VERSION = 1;

// Deliberately not batched. One request per label is what keeps a label
// cacheable in isolation and lets a single failure retry without redoing its
// neighbours; concurrency, not batching, is the throughput lever.
const CONCURRENCY = Number(process.env.LABEL_CONCURRENCY) || 8;

// A call too short to have gone anywhere — a wrong number, an immediate hangup.
// The operational dimensions are left unexercised rather than failed for these:
// an agent cannot be marked down for not capturing data from someone who never
// spoke. This gate is pure code on purpose, so the two dimensions the
// ground-truth check depends on stay free of any model judgement.
const SUBSTANTIAL_SECONDS = 20;
const SUBSTANTIAL_TURNS = 4;

const turnCount = (transcript) => transcript.split(/\n(?=bot:|human:)/).length;

const isSubstantial = (call) =>
  call.durationSec >= SUBSTANTIAL_SECONDS && turnCount(call.transcript) >= SUBSTANTIAL_TURNS;

// Keyed by callId alone — never by run, agent or batch. Re-running the analysis,
// or analyzing a different agent, must not invalidate a label.
const labelKey = (locationId, callId) => `label:${locationId}:${callId}`;

const verdict = { type: "string", enum: VERDICTS };

const LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "outcome",
    ...READ_DIMENSIONS,
    "callerAskedForHuman",
    "callerAbandoned",
    "issueTypes",
    "severity",
    "reason",
  ],
  properties: {
    outcome: { type: "string", enum: ["success", "failure", "missed_opportunity"] },
    ...Object.fromEntries(READ_DIMENSIONS.map((d) => [d, verdict])),
    callerAskedForHuman: {
      type: "boolean",
      description: "Did the caller ask to speak to a person, at any point?",
    },
    callerAbandoned: {
      type: "boolean",
      description: "Did the caller hang up or stop responding before the agent finished?",
    },
    issueTypes: { type: "array", items: { type: "string", enum: ISSUE_TYPES } },
    severity: { type: "string", enum: ["none", "low", "medium", "high"] },
    reason: { type: "string", description: "One line. What happened on this call." },
    // Omitted on a clean call. A success needs no evidence, and at 10,000 calls
    // this is the difference between ~2M and ~1.2M output tokens on a backfill.
    keyQuote: {
      type: "string",
      description:
        "A verbatim quote showing the single worst moment. Omit entirely when nothing went wrong.",
    },
  },
};

const LABELLER_SYSTEM = `You read one Voice AI phone call and classify it. You are not writing
a report — you are filling in a record that will be counted alongside thousands of others.

- Judge only this call. You have no knowledge of the agent's other calls and must not guess at
  patterns.
- Judge the agent against its own configured purpose, not against an ideal agent.
- A dimension this call never exercised is "not_exercised" — never a guess. A caller who never
  raised an objection tells you nothing about objection handling.
- "fail" means the agent did something wrong, not that the call was unlucky. A caller who hangs
  up in the first seconds is not a failure of prompt adherence.
- Quote verbatim or not at all. Copy the words exactly as they appear in the transcript.`;

function labelPrompt(agent, call) {
  return `# The agent
${agent.name} (${agent.businessName}) — a Voice AI phone agent.
Its configured purpose, in its own prompt:
${agent.prompt || "(no prompt configured)"}

# The call (${call.durationSec}s)${call.isTestCall ? "\nThis is a test call — the operator probing their own agent, not a customer." : ""}

${call.transcript}

# Your task
Classify this one call.

Outcome: success, failure, or missed_opportunity.

Then judge each of these, as pass, fail, or not_exercised:
- prompt_adherence — did it follow its configured prompt and script?
- intent_recognition — did it correctly identify what the caller wanted?
- task_completion — did it finish the job it exists to do? not_exercised if the caller never
  asked it to do anything.
- conversation_control — turn-taking, interruptions, talking over the caller.
- loop_avoidance — did it repeat itself or circle without progressing?
- knowledge_grounding — did it answer from what it was configured to know, rather than
  inventing? not_exercised if it was asked nothing factual.
- resolution — did the caller get what they called for?

Then two facts, which are counted rather than read:
- callerAskedForHuman — did the caller ask for a person?
- callerAbandoned — did the caller hang up or go silent before the agent was done?

Then the issue types present, from: ${ISSUE_TYPES.join(", ")}. An empty list is the right answer
for a call that went well.

Then a severity for the call as a whole, and one line saying what happened. If anything went
wrong, include keyQuote — the verbatim words showing the worst moment. If nothing went wrong,
leave keyQuote out.`;
}

/**
 * The reading of one transcript, from cache or from a model.
 *
 * Only the transcript-derived part is cached. The verdicts that depend on the
 * agent's configuration are computed fresh in `resolve` below, because a
 * transcript is immutable and an agent's configuration is not — caching a
 * verdict about `maxCallDuration` would go quietly stale the moment someone
 * changed it.
 */
async function readCall(auth, agent, call) {
  const key = labelKey(auth.locationId, call.callId);

  const cached = await store.get(key);
  if (cached?.v === LABEL_VERSION) return { reading: cached.reading, fromCache: true };

  const reading = await complete({
    models: LABEL_MODELS,
    system: LABELLER_SYSTEM,
    prompt: labelPrompt(agent, call),
    schema: LABEL_SCHEMA,
    maxTokens: 2000,
    // One retry cycle rather than three: with thousands of calls in flight, a
    // call that will not label is cheaper to drop and report than to wait on.
    attempts: 2,
    validate: (r) => {
      const missing = READ_DIMENSIONS.filter((d) => !VERDICTS.includes(r[d]));
      return missing.length ? `dimensions not judged: ${missing.join(", ")}` : null;
    },
  });

  // No TTL, deliberately. A location token expires because it genuinely goes
  // stale; a reading of an immutable transcript cannot. A TTL here would
  // quietly reintroduce the re-processing this design exists to prevent — and
  // it would look like it was working, just getting more expensive.
  await store.set(key, { v: LABEL_VERSION, reading });

  return { reading, fromCache: false };
}

/**
 * The full twelve-dimension verdict for one call: the model's reading of the
 * conversation, plus the dimensions the call record settles by itself.
 */
function resolve(agent, call, reading) {
  const substantial = isSubstantial(call);

  // Within a few seconds of the cap is the cap. The agent did not choose to end
  // the call; it ran out of time mid-flow.
  const hitDurationCap = agent.maxCallDuration && call.durationSec >= agent.maxCallDuration - 5;

  const dimensions = {
    ...Object.fromEntries(READ_DIMENSIONS.map((d) => [d, reading[d]])),

    // Recorded, not read. A substantial conversation in which the agent
    // triggered nothing is a tool_execution failure, whatever it said while
    // doing so.
    //
    // Note that no actions being *configured* is a failure too, not an excuse.
    // An appointment-booking agent with no booking action wired up cannot book
    // anything, ever — scoring that "not evaluated" would hide the single worst
    // thing about it behind a dash, which is exactly the decorative-framework
    // failure this rubric exists to avoid.
    tool_execution: !substantial ? "not_exercised" : call.actionsExecuted.length ? "pass" : "fail",

    data_capture: !substantial
      ? "not_exercised"
      : Object.keys(call.dataCollected).length
        ? "pass"
        : "fail",

    // A transfer that happened is a pass on the record. A transfer the caller
    // asked for and did not get is a fail. Everything else is unexercised —
    // most calls simply never raise the question.
    routing_escalation: call.transferred
      ? "pass"
      : reading.callerAskedForHuman
        ? "fail"
        : "not_exercised",

    call_completion: hitDurationCap || reading.callerAbandoned ? "fail" : "pass",

    responsiveness: "not_exercised",
  };

  return {
    callId: call.callId,
    createdAt: call.createdAt,
    durationSec: call.durationSec,
    isTestCall: call.isTestCall,
    outcome: reading.outcome,
    dimensions,
    issueTypes: reading.issueTypes,
    severity: reading.severity,
    reason: reading.reason,
    keyQuote: reading.keyQuote ?? "",
  };
}

/**
 * Label every call, reading only the ones not already read.
 *
 * Returns the split — `{ labelled, fromCache }` — so the once-only invariant is
 * visible rather than assumed. If `labelled` is non-zero on an account where
 * nothing has changed, something is wrong.
 *
 * A call whose label fails after its retries is dropped rather than failing the
 * run: on a thousand-call backfill, one unreadable transcript is not worth
 * losing the other 999. The count comes back so the run can say so.
 */
export async function labelAll(auth, agent, calls, { onProgress } = {}) {
  const labels = new Array(calls.length);
  const failures = [];
  // `failed` is carried alongside the two useful counts so that everything
  // adds up to `total`. A caller watching for the phase to end compares the sum
  // against the total, and a dropped label would otherwise leave it one short
  // forever.
  const progress = { labelled: 0, fromCache: 0, failed: 0, total: calls.length };

  let next = 0;

  async function worker() {
    for (let i = next++; i < calls.length; i = next++) {
      try {
        const { reading, fromCache } = await readCall(auth, agent, calls[i]);
        labels[i] = resolve(agent, calls[i], reading);
        if (fromCache) progress.fromCache++;
        else progress.labelled++;
      } catch (err) {
        failures.push({ callId: calls[i].callId, error: err.message });
        progress.failed++;
      }
      onProgress?.(progress);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, calls.length) }, worker));

  return {
    labels: labels.filter(Boolean),
    labelled: progress.labelled,
    fromCache: progress.fromCache,
    failures,
  };
}
