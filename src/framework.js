// The evaluation framework, in one place.
//
// Every agent is scored on the same twelve dimensions on every run, so a user
// can see where an agent is weak before reading what it said, and so two agents
// or two runs can be compared. The labeller judges a call against them, the
// aggregator counts, the synthesizer files its issues under them, and verify.js
// checks the result — four consumers, which is why the list is not written out
// four times.

// How each dimension is decided. This split is the reason a twelve-dimension
// rubric is not twelve flavours of opinion:
//
//   recorded  — settled by a field on the call record. No model involved, so the
//               dimensions the ground-truth check depends on carry no trust
//               question at all. An agent that says it booked an appointment
//               while no action was executed is failing tool_execution however
//               fluent it sounded.
//   hybrid    — a recorded field decides the verdict, but the model supplies one
//               narrow observable fact the field cannot carry. Whether a
//               transfer happened is recorded; whether the caller asked for one
//               is not, and without it every untransferred call would look
//               either fine or broken depending on which way you guessed.
//   read      — requires reading the conversation.
//   none      — not evaluable from this data at all.
export const DIMENSIONS = {
  prompt_adherence: { group: "Conversation", source: "read" },
  intent_recognition: { group: "Conversation", source: "read" },
  task_completion: { group: "Conversation", source: "read" },
  conversation_control: { group: "Conversation", source: "read" },
  loop_avoidance: { group: "Conversation", source: "read" },
  tool_execution: { group: "Operational", source: "recorded" },
  knowledge_grounding: { group: "Operational", source: "read" },
  data_capture: { group: "Operational", source: "recorded" },
  routing_escalation: { group: "Operational", source: "hybrid" },
  call_completion: { group: "Operational", source: "hybrid" },
  // The call log records total duration only — no per-turn timing, no
  // recording. Latency is not evaluable from this data, so this is permanently
  // not_evaluated rather than quietly guessed at.
  responsiveness: { group: "Operational", source: "none" },
  resolution: { group: "Outcome", source: "read" },
};

export const DIMENSION_IDS = Object.keys(DIMENSIONS);

/** The dimensions the labelling model is asked to judge. */
export const READ_DIMENSIONS = DIMENSION_IDS.filter((d) => DIMENSIONS[d].source === "read");

// A call either exercised a dimension or it did not, and a dimension nothing
// exercised is not a zero. If nobody asked for a human, you cannot know whether
// escalation works — so the aggregate scores over exercised calls only and says
// how many that was.
export const VERDICTS = ["pass", "fail", "not_exercised"];

export const ISSUE_TYPES = [
  "missed_qualification_question",
  "poor_objection_handling",
  "incorrect_tone",
  "incomplete_booking_flow",
  "weak_follow_up",
  "policy_violation",
];

export const SEVERITIES = ["high", "medium", "low"];

/**
 * A pass rate turned into the word the Scorecard shows.
 *
 * Thresholds are deliberately unforgiving in the middle: an agent that fails one
 * call in five is not "adequate" to the business paying for it.
 */
export function statusFor(score) {
  if (score === null) return "not_evaluated";
  if (score >= 90) return "strong";
  if (score >= 70) return "adequate";
  if (score >= 40) return "weak";
  return "failing";
}

export const isWeak = (status) => status === "weak" || status === "failing";
