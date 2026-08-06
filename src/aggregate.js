// Tier 2: turn labels into numbers. No model runs here, and that is the point.
//
// Every figure the Scorecard shows is arithmetic over every call that has been
// labelled, so "tool execution fails in 3 of 1,240 calls" is a count, not a
// sample statistic wearing a count's clothes. It is also instant, which is what
// lets a new call update the Scorecard without re-running the expensive half.
import { DIMENSIONS, DIMENSION_IDS, ISSUE_TYPES, statusFor, isWeak } from "./framework.js";

const OUTCOMES = ["success", "failure", "missed_opportunity"];

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What the numbers mean, written in code because the numbers are already known.
 *
 * The narrative belongs to the deep dive, which reads actual transcripts. A
 * sentence here is a caption for a count, and asking a model to write captions
 * for counts it was handed is latency the user waits through for nothing.
 */
function summarize(dimension, { passed, failed, notExercised, total }) {
  if (DIMENSIONS[dimension].source === "none") {
    return "The call log records total duration only — no per-turn timing and no recording — so latency cannot be measured from this data.";
  }
  if (!passed && !failed) {
    return `None of the ${plural(total, "call")} exercised this, so it is not scored. A dimension nothing tested is not a zero.`;
  }

  const scope = `Passed ${passed} of the ${plural(passed + failed, "call")} that exercised it`;
  return notExercised
    ? `${scope}. The other ${plural(notExercised, "call")} never raised it.`
    : `${scope} — every call in the record.`;
}

/**
 * Framework scores, issue frequencies and outcome mix over 100% of the labelled
 * calls.
 *
 * Scores are computed over the calls that exercised a dimension, never over all
 * of them. An agent nobody ever asked for a human does not score zero on
 * escalation; it scores nothing, and the card says how many calls that was.
 */
export function aggregate(labels) {
  const total = labels.length;

  const framework = DIMENSION_IDS.map((dimension) => {
    const verdicts = labels.map((l) => l.dimensions[dimension]);
    const counts = {
      passed: verdicts.filter((v) => v === "pass").length,
      failed: verdicts.filter((v) => v === "fail").length,
      notExercised: verdicts.filter((v) => v !== "pass" && v !== "fail").length,
      total,
    };

    const exercised = counts.passed + counts.failed;
    const score = exercised ? Math.round((100 * counts.passed) / exercised) : null;

    return {
      dimension,
      source: DIMENSIONS[dimension].source,
      status: statusFor(score),
      score,
      exercised,
      callsAffected: counts.failed,
      callsScored: total,
      summary: summarize(dimension, counts),
    };
  });

  // Frequency is a count over every labelled call, so an issue the synthesizer
  // narrates from ten sampled transcripts still reports how often it actually
  // happens across the whole record.
  const issueFrequency = Object.fromEntries(
    ISSUE_TYPES.map((type) => [type, labels.filter((l) => l.issueTypes.includes(type)).length]),
  );

  return {
    callsScored: total,
    testCalls: labels.filter((l) => l.isTestCall).length,
    framework,
    issueFrequency,
    outcomes: Object.fromEntries(
      OUTCOMES.map((outcome) => [outcome, labels.filter((l) => l.outcome === outcome).length]),
    ),
    // Ordered worst first, which is both what the reader wants and what the
    // sampler uses to decide which transcripts are worth a strong model's time.
    weakest: framework
      .filter((d) => isWeak(d.status))
      .sort((a, b) => a.score - b.score)
      .map((d) => d.dimension),
  };
}
