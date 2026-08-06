// Choose the handful of calls the strong model actually reads.
//
// Synthesis needs representative failures, not all of them. Nobody writes a
// better prompt patch from 10,000 transcripts than from the 10 worst, and the
// aggregate has already established what is worst and how often it happens —
// so the expensive reasoning stops scaling with the corpus.
//
// The selection is deliberate rather than recent. Picking the newest calls is
// how the old design ended up reporting on the agent's last few days; picking
// the worst calls per weak dimension is how the deep dive ends up about the
// agent's actual problems.
const SIZE = 10;

// At most two per dimension, so one bad dimension cannot crowd out the rest.
const PER_DIMENSION = 2;
const SUCCESSES = 2;

const SEVERITY_RANK = { high: 0, medium: 1, low: 2, none: 3 };

const failedCount = (label) =>
  Object.values(label.dimensions).filter((v) => v === "fail").length;

/**
 * Worst first: by severity, then by how much went wrong, then by how real the
 * call was. A test call is the operator probing their own agent — evidence, but
 * weaker evidence than a customer having the same experience.
 */
const severityOf = (label) => SEVERITY_RANK[label.severity] ?? SEVERITY_RANK.none;

const byWorst = (a, b) =>
  severityOf(a) - severityOf(b) ||
  failedCount(b) - failedCount(a) ||
  Number(a.isTestCall) - Number(b.isTestCall) ||
  new Date(b.createdAt) - new Date(a.createdAt);

/**
 * ~10 calls: the worst examples of each weak dimension, plus a couple of
 * successes for contrast.
 *
 * The successes matter more than they look. Without them the synthesizer reads
 * ten disasters and concludes the agent is a disaster, when the aggregate may
 * be saying it fails one call in six.
 */
export function selectSample(labels, calls, { size = SIZE, weakest = [] } = {}) {
  const byId = new Map(calls.map((c) => [c.callId, c]));
  const chosen = new Map();

  // `cap` rather than `size`, because the contrast slots are reserved before the
  // failures are allowed to fill up. A call is claimed by the first pass that
  // wants it and keeps that pass's reason, so the order below is also the order
  // the reasons are assigned in — which is why contrast is chosen before the
  // general fill rather than after it.
  const take = (label, why, cap) => {
    if (chosen.size >= cap || chosen.has(label.callId)) return;
    const call = byId.get(label.callId);
    if (call) chosen.set(label.callId, { call, label, why });
  };

  // "Went well" means the caller got what they came for, not that nothing at all
  // went wrong. An agent with one systemically failing dimension — no booking
  // action wired up, say — has a failure on every call, and requiring a spotless
  // one would drop the contrast exactly where it is most needed.
  const successes = labels
    .filter((l) => l.outcome === "success")
    .sort(
      (a, b) =>
        failedCount(a) - failedCount(b) ||
        Number(a.isTestCall) - Number(b.isTestCall) ||
        new Date(b.createdAt) - new Date(a.createdAt),
    )
    .slice(0, SUCCESSES);

  // Claimed first, so that a call which both went well and failed a dimension is
  // described as the contrast it is rather than as one more disaster. On an
  // agent where every call trips the same broken dimension, that is every
  // contrast call there is.
  successes.forEach((l) => take(l, "a call that went well, for contrast", SUCCESSES));

  // Worst per weak dimension, weakest dimension first.
  for (const dimension of weakest) {
    labels
      .filter((l) => l.dimensions[dimension] === "fail")
      .sort(byWorst)
      .slice(0, PER_DIMENSION)
      .forEach((l) => take(l, `worst example of ${dimension}`, size));
  }

  // Whatever is still worst overall, for dimensions that are weak but not weak
  // enough to have made the list, and for agents with no weak dimension at all.
  labels
    .filter((l) => failedCount(l) > 0)
    .sort(byWorst)
    .forEach((l) => take(l, "among the worst calls overall", size));

  // An agent with no failures at all: fall back to the most recent calls, so the
  // deep dive still has something to read.
  if (!chosen.size) {
    [...labels]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .forEach((l) => take(l, "most recent", size));
  }

  // Contrast reads last. It was claimed first to get the reason right, but the
  // sample is presented worst-first — leading with the call that went well would
  // set the wrong frame for everything after it.
  const isContrast = (e) => e.why.startsWith("a call that went well");
  return [...chosen.values()].sort((a, b) => Number(isContrast(a)) - Number(isContrast(b)));
}
