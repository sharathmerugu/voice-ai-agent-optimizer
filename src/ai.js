// The two LLM steps of the optimizer. Prompts live directly above the function
// that sends them.
//
// Structured outputs guarantee the response matches the schema, so there is no
// parse-and-retry path here: a malformed response is not a case we can reach.
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// Opus is the default because the analysis quality matters more than its cost here.
// Overridable so a run can be moved to another model when one is under load, or when
// a deployment wants a cheaper pass.
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";

// Thinking is on by default on Opus 5 and counts against max_tokens, so these
// requests stream to stay clear of HTTP timeouts.
//
// A full pass is three of these calls over several minutes. The SDK retries a
// request that fails before the stream opens, but an overload that arrives
// mid-stream surfaces here — and losing the whole run to a transient error is
// expensive enough to be worth one more attempt.
async function complete(args, attempt = 1) {
  try {
    const result = await streamOnce(args);

    // Structured outputs guarantee the response matches the schema, not that it
    // says anything. Empty arrays are schema-valid, and the format does not
    // support minimum-length constraints — so "did it actually answer" has to be
    // checked here. A run that returns no findings and no test cases would
    // otherwise flow downstream and be presented as a result.
    const problem = args.validate?.(result);
    if (problem) throw new Error(`Model returned an unusable response: ${problem}`);

    return result;
  } catch (err) {
    const transient =
      err?.error?.error?.type === "overloaded_error" ||
      err?.status >= 500 ||
      err.message?.startsWith("Model returned an unusable response");
    if (!transient || attempt > 4) throw err;

    // Back off further each time — an overload lasting a few seconds and one
    // lasting a minute both cost the same lost run if we give up early.
    await new Promise((resolve) => setTimeout(resolve, attempt * 15000));
    return complete(args, attempt + 1);
  }
}

async function streamOnce({ system, prompt, schema }) {
  const stream = client.messages.stream({
    model: MODEL,
    // The analyze call emits call outcomes, twelve scored dimensions, the issue
    // patterns with their citations, and the test suite — and thinking counts
    // against this ceiling too. 32k truncated it once the framework was added.
    max_tokens: 64000,
    system,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "max_tokens") {
    throw new Error("Model response was truncated. Reduce the transcript batch size.");
  }

  const text = message.content.find((block) => block.type === "text")?.text;
  if (!text) throw new Error(`Model returned no text (stop_reason: ${message.stop_reason})`);

  return JSON.parse(text);
}

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

function describeTranscripts(transcripts) {
  return transcripts
    .map(
      (t) => `## Call ${t.callId} (${t.durationSec}s)${t.isTestCall ? " — test call, not a customer" : ""}
Actions the agent actually triggered: ${t.actionsExecuted.length ? t.actionsExecuted.join(", ") : "none"}
Data the agent actually captured: ${Object.keys(t.dataCollected).length ? JSON.stringify(t.dataCollected) : "none"}
Transferred to a human: ${t.transferred ? "yes" : "no"}

${t.transcript}`,
    )
    .join("\n\n");
}

// A fixed evaluation framework, applied to every agent on every run, so a user can
// see where an agent is weak before reading what it said. The issue list below is
// the drill-down: each issue is filed under exactly one dimension.
//
// Four of these are judged from hard fields rather than the model's reading of a
// transcript — tool_execution from executedCallActions, data_capture from
// extractedData, routing_escalation from agentTransferOccurred, call_completion
// from duration. That is what keeps a twelve-dimension rubric from becoming twelve
// flavours of opinion.
const DIMENSIONS = [
  // Conversation
  "prompt_adherence",
  "intent_recognition",
  "task_completion",
  "conversation_control",
  "loop_avoidance",
  // Operational
  "tool_execution",
  "knowledge_grounding",
  "data_capture",
  "routing_escalation",
  "call_completion",
  "responsiveness",
  // Outcome
  "resolution",
];

const ISSUE_TYPES = [
  "missed_qualification_question",
  "poor_objection_handling",
  "incorrect_tone",
  "incomplete_booking_flow",
  "weak_follow_up",
  "policy_violation",
];

const ANALYZE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["callOutcomes", "framework", "issuePatterns", "testCases"],
  properties: {
    framework: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dimension", "status", "score", "callsAffected", "summary"],
        properties: {
          dimension: { type: "string", enum: DIMENSIONS },
          status: {
            type: "string",
            enum: ["strong", "adequate", "weak", "failing", "not_evaluated"],
          },
          score: {
            type: ["integer", "null"],
            description: "0-100. Null when the dimension is not_evaluated.",
          },
          callsAffected: { type: "integer" },
          summary: { type: "string" },
        },
      },
    },
    callOutcomes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["callId", "outcome", "reason"],
        properties: {
          callId: { type: "string" },
          outcome: { type: "string", enum: ["success", "failure", "missed_opportunity"] },
          reason: { type: "string" },
        },
      },
    },
    issuePatterns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dimension", "type", "title", "severity", "frequency", "evidence"],
        properties: {
          dimension: { type: "string", enum: DIMENSIONS },
          type: { type: "string", enum: ISSUE_TYPES },
          title: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          frequency: { type: "integer" },
          evidence: {
            type: "array",
            items: { type: "string" },
            description: "Verbatim quotes from the transcripts. Never paraphrase.",
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

const ANALYST_SYSTEM = `You audit Voice AI phone agents for a business. You are given an
agent's live configuration and the transcripts of real calls it handled, and you report
what actually went wrong.

Rules you do not break:
- Every issue you report must be supported by a verbatim quote from a transcript. Copy the
  words exactly as they appear. If you cannot quote it, you may not report it.
- Judge the agent against its own stated goal and configuration, not against an ideal agent.
- An issue is a pattern only if it recurs. Report the frequency honestly, including 1.
- Do not invent problems to fill out the list. A well-handled call is a success.
- Calls marked as test calls are the operator probing their own agent, not customers.
  Behaviour that only appears under probing says less about customer experience than the
  same behaviour in a real call. Weigh them accordingly, and say so when a pattern rests
  only on test calls.

You also score the agent against a fixed framework, so a reader can see where it is weak
before reading what it said. Rules for that:
- Score every dimension exactly once. None may be omitted.
- A dimension no call exercised is not_evaluated with a null score — never a guess. If
  nobody asked for a human, you cannot know whether escalation works.
- Four dimensions are settled by recorded fields, not by how the call reads. An agent that
  says it booked an appointment while no action was executed is failing tool_execution
  however fluent it sounded; the same holds for data_capture against captured data,
  routing_escalation against the transfer flag, and call_completion against duration.
- The framework and the issue list must agree. A dimension carrying a high-severity issue
  cannot be strong, and a dimension with affected calls must have an issue filed under it.
  File every issue under the single dimension that best explains it.`;

/**
 * One call covering three assignment requirements: analyze the transcripts, detect
 * recurring failure patterns, and generate the test suite. They share the same inputs,
 * and the test cases should be derived from the failures actually observed.
 */
export function analyze({ agent, transcripts }) {
  const prompt = `# Agent under review

${describeAgent(agent)}

# Call transcripts

${describeTranscripts(transcripts)}

# Your task

1. Classify every call as success, failure, or missed_opportunity, with a one-line reason.

2. Score the agent on all twelve framework dimensions:

   Conversation
   - prompt_adherence — does it follow its configured prompt and script?
   - intent_recognition — does it correctly identify what the caller wants?
   - task_completion — does it finish the job it exists to do?
   - conversation_control — turn-taking, interruptions, talking over the caller
   - loop_avoidance — does it repeat itself or circle without progressing?

   Operational
   - tool_execution — does it fire the right actions? Judge against actions actually
     triggered, not against what the agent claimed.
   - knowledge_grounding — does it answer from configured knowledge rather than inventing?
   - data_capture — does it collect what it needs? Judge against data actually captured.
   - routing_escalation — does it hand off when it should?
   - call_completion — abandonment and clean endings. Distinguish the two forms in your
     summary: a caller who stops responding or hangs up mid-flow was lost by the agent,
     while an agent whose final turn cuts off mid-sentence or closes without collecting
     what it needed is a configuration problem. Compare duration against the agent's
     maximum call duration to tell a cap from a stop.
   - responsiveness — this call log records total duration only, with no per-turn timing
     and no recording. Latency is not evaluable from this data: return not_evaluated with
     a null score and say so.

   Outcome
   - resolution — did the caller get what they called for?

3. Identify the recurring issues. Use only these types: ${ISSUE_TYPES.join(", ")}, and file
   each one under the single framework dimension that best explains it.
   For each, give a specific title (not the type name), a severity, how many calls it
   appears in, and verbatim quotes as evidence.

4. Generate exactly 6 test cases for regression-testing this agent. Derive them from the
   issues you found — at least half should cover scenarios these transcripts actually
   exercised, so the results can be checked against real evidence. Include both happy-path
   and edge-case scenarios.

   Give each case a stable id (tc-1 … tc-6) and 3-5 success criteria. Each criterion must
   be a single checkable claim about the agent's behaviour, phrased as a requirement —
   for example "Collects the caller's email address before ending the call". Draw on:
   collecting required contact information, following the booking flow, staying on brand
   and polite, handling interruptions and objections, and avoiding unsupported claims.`;

  return complete({
    system: ANALYST_SYSTEM,
    prompt,
    schema: ANALYZE_SCHEMA,
    // issuePatterns may legitimately be empty — an agent can have no recurring
    // problems. The other two cannot: every dimension is always scored, and the
    // suite is always six cases.
    validate: (r) => {
      const missing = DIMENSIONS.filter((d) => !r.framework.some((f) => f.dimension === d));
      if (missing.length) return `dimensions not scored: ${missing.join(", ")}`;
      if (r.testCases.length !== 6) return `${r.testCases.length} test cases, expected 6`;
      if (r.callOutcomes.length !== transcripts.length) {
        return `${r.callOutcomes.length} call outcomes for ${transcripts.length} transcripts`;
      }
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

const CASE_RESULT_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "verdicts"],
    properties: {
      id: { type: "string" },
      verdicts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterion", "pass", "tag", "evidence", "reason"],
          properties: {
            criterion: { type: "string" },
            pass: { type: "boolean" },
            tag: { type: "string", enum: ["observed", "predicted"] },
            evidence: {
              type: "string",
              description:
                "For observed verdicts, a verbatim transcript quote. For predicted verdicts, an empty string.",
            },
            reason: { type: "string" },
          },
        },
      },
    },
  },
};

const EVALUATOR_SYSTEM = `You evaluate whether a Voice AI agent's configuration satisfies a
set of test criteria, and you are strict about the difference between what you measured and
what you inferred.

Every verdict carries a tag:
- "observed" — a real call in the transcripts already exercised this criterion. The evidence
  field must contain a verbatim quote from that transcript.
- "predicted" — no call exercised it. The verdict follows from a gap in the agent's
  configuration, and the evidence field must be empty.

Tagging a verdict "observed" when you cannot quote a real transcript is the one error that
invalidates this entire report. When a criterion is only partly exercised by a real call,
tag it predicted. Prefer predicted whenever you are unsure.`;

/**
 * Evaluates the test suite against a configuration. Called twice: once for the current
 * config (with recommendations, which need the failures this pass produces), and once for
 * the patched config to measure the before/after delta.
 *
 * Patches are never applied by string surgery — the patched pass receives the original
 * prompt plus the patch list and evaluates as if they were applied.
 */
export function evaluate({
  agent,
  testCases,
  transcripts,
  issuePatterns,
  patches,
  configChanges,
  recommend,
}) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: recommend ? ["cases", "recommendations", "patches"] : ["cases"],
    properties: {
      cases: CASE_RESULT_SCHEMA,
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

${describeTranscripts(transcripts)}

# Test cases

${testCases
  .map(
    (tc) => `## ${tc.id} — ${tc.name} (${tc.type} path)
Persona: ${tc.persona}
Scenario: ${tc.scenario}
Criteria:
${tc.successCriteria.map((c) => `- ${c}`).join("\n")}`,
  )
  .join("\n\n")}

# Your task

For every test case, return a verdict on every one of its criteria. Judge against the
configuration above${patches || configChanges?.length ? " with the pending changes applied" : ""}.
Copy each criterion back exactly as written, and tag each verdict observed or predicted as
defined in your instructions.${
    recommend
      ? `

Then recommend configuration changes that would fix the failures.

Detected issue patterns:
${issuePatterns.map((p) => `- [${p.severity}] ${p.title} (${p.frequency} calls)`).join("\n")}

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
    system: EVALUATOR_SYSTEM,
    prompt,
    schema,
    // Every case must come back with a verdict on every criterion. A short reply
    // here would silently understate the score, or — if the suite came back empty
    // — invite the model to invent cases of its own.
    validate: (r) => {
      if (r.cases.length !== testCases.length) {
        return `${r.cases.length} results for ${testCases.length} test cases`;
      }
      for (const tc of testCases) {
        const scored = r.cases.find((c) => c.id === tc.id);
        if (!scored) return `no result for ${tc.id}`;
        if (scored.verdicts.length !== tc.successCriteria.length) {
          return `${tc.id}: ${scored.verdicts.length} verdicts for ${tc.successCriteria.length} criteria`;
        }
      }
      return null;
    },
  });
}
