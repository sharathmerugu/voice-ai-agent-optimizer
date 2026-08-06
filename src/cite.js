// Does this quote actually appear in the call record?
//
// A quote is the load-bearing claim in this app: an `observed` verdict asserts a
// measurement, and an issue is only reportable if it can be quoted. A quote that
// reads better than the transcript is a quote that gets checked and fails.
//
// Two consumers, which is why it lives here rather than in either of them:
// pipeline.js runs it before a run is stored, so an uncheckable quote never
// reaches the UI; verify.js runs it over a stored run as an external audit that
// makes no assumptions about the pipeline having done its job.

// The model reproduces the words faithfully but does not always preserve the
// original unicode punctuation, so compare on normalized text.
const normalize = (s) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Each speaker's own words, in order, with the other's removed.
 *
 * An interruption splits the agent's sentence across two `bot:` turns with a
 * `human:` turn wedged between them — so quoting what the agent actually said
 * produces text that appears nowhere in the transcript as written. Quoting it
 * *with* the interruption spliced back in would be worse.
 *
 * This is a real loosening and worth naming: a quote may now skip over the
 * caller's words. It may not skip over the agent's, reorder anything, or
 * invent a syllable, which is what the check is for.
 */
const speakerStream = (transcript, speaker) =>
  transcript
    .split(/\n(?=bot:|human:)/)
    .filter((turn) => turn.startsWith(`${speaker}:`))
    .map((turn) => turn.slice(speaker.length + 1))
    .join("");

/**
 * Everything a quote is allowed to have come from, as one normalized string.
 *
 * Evidence may cite a transcript, or a recorded field — four framework
 * dimensions are judged from what the call actually did rather than what it
 * said. Both are checkable; both are included here, in the same wording the
 * model was shown them in.
 */
export function corpusOf(sample) {
  return normalize(
    sample
      .map(
        ({ call }) =>
          `${call.transcript}\n` +
          `${speakerStream(call.transcript, "bot")}\n` +
          `${speakerStream(call.transcript, "human")}\n` +
          `Actions the agent actually triggered: ${call.actionsExecuted.length ? call.actionsExecuted.join(", ") : "none"}\n` +
          `Data the agent actually captured: ${Object.keys(call.dataCollected).length ? JSON.stringify(call.dataCollected) : "none"}\n` +
          `Transferred to a human: ${call.transferred ? "yes" : "no"}`,
      )
      .join("\n"),
  );
}

// A citation may join passages that are not adjacent — with an ellipsis, a
// slash, or a line break where two turns were quoted together. Each fragment
// still has to be real; only the seam between them is allowed to be invented.
//
// Fragments shorter than this are dropped rather than checked: a stray "bot:"
// or a three-word connector matches almost any transcript, so requiring it
// proves nothing and rejecting it would fail honest quotes.
const MEANINGFUL = 12;

const fragments = (quote) =>
  quote
    .split(/\s*(?:\.\.\.|…|\/|\n)\s*/)
    .map(normalize)
    .filter((f) => f.length > MEANINGFUL);

/** Whether every meaningful fragment of `quote` appears verbatim in `corpus`. */
export function cites(corpus, quote) {
  const parts = fragments(quote);
  return parts.length ? parts.every((p) => corpus.includes(p)) : corpus.includes(normalize(quote));
}
