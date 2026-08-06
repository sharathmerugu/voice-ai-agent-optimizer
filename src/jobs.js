// An analysis is a batch job, not a page load.
//
// Nobody sits and watches this. They open the app, trigger a run, leave, and come
// back — daily, weekly, monthly — to see how their agents are doing. Once that is
// the product, the length of the job stops mattering and the honesty of the
// progress figure starts to. A five-minute job is only a problem if someone is
// watching a spinner.
//
// So POST creates a job and returns immediately, the page polls, and the result
// is waiting whether or not the tab stayed open.
import * as store from "./store.js";
import { run } from "./pipeline.js";

const jobKey = (locationId, agentId) => `job:${locationId}:${agentId}`;

// A job record outlives the process that wrote it, so a crash would otherwise
// leave an agent permanently "analyzing". Past this, a running job is presumed
// dead and a new one may start.
const STALE_MS = 45 * 60 * 1000;

// Redis expires the record on its own; the file backend ignores TTLs, which is
// why the age check above exists as well rather than instead.
const JOB_TTL_SECONDS = 3 * 60 * 60;

// Progress moves once per labelled call. On a thousand-call account that is a
// thousand writes to Redis to render a number nobody reads more than once every
// few seconds.
const PROGRESS_INTERVAL_MS = 1500;

// Process-local single-flight. The stored record is what the browser polls and
// what survives a restart; this map is what actually prevents a duplicate,
// because checking it is synchronous and so cannot be raced by two requests
// arriving together. Two people opening the same sub-account must not trigger
// two analyses — that is duplicated spend and a race over the same cache keys.
const running = new Map();

// Which process wrote a job record. A job whose owner is gone is dead, however
// recently it started — and on a free-tier host that restarts routinely, that
// is the common case rather than the exception. Without this, a run interrupted
// by a restart leaves the page watching a progress bar that will never move
// again until the staleness window below finally expires.
//
// This assumes one instance. On several, an instance would call another's live
// job dead and start a second — wasteful, but it recovers; the reverse mistake
// does not. Revisit if this is ever scaled out.
const OWNER = `${process.pid}-${Date.now()}`;

const inProgress = (job) =>
  Boolean(job) && (job.status === "labelling" || job.status === "synthesizing");

/** In progress, and someone is still working on it. */
const isActive = (job) =>
  inProgress(job) &&
  job.owner === OWNER &&
  Date.now() - new Date(job.startedAt).getTime() < STALE_MS;

export async function readJob(locationId, agentId) {
  const key = jobKey(locationId, agentId);

  // A job running in this process is read from memory, not from the store. The
  // stored copy is a throttled snapshot written for other instances and for
  // restarts; serving it here would show the page a progress figure that is
  // always a beat behind, and a status that is stale for the whole of synthesis.
  const live = running.get(key);
  if (live) return live.job;

  const job = await store.get(key);
  if (!job) return null;

  // A job whose process died mid-run is reported as failed rather than left
  // spinning, so the page offers a retry instead of a progress bar that will
  // never move again. Either signal is enough: a different owner means the
  // process that was working on it is gone, and the age check catches a job
  // this process started and then somehow lost.
  if (inProgress(job) && !isActive(job)) {
    return { ...job, status: "failed", error: "The analysis stopped unexpectedly. Try again." };
  }
  return job;
}

/**
 * Start an analysis, or join the one already running.
 *
 * Returns the job record either way. The caller never waits for the analysis
 * itself — that is the whole point — so failures are recorded on the job rather
 * than thrown.
 */
export async function startJob(auth, agentId, userFacing = (e) => e.message) {
  const key = jobKey(auth.locationId, agentId);

  if (running.has(key)) return running.get(key).job;

  const existing = await store.get(key);
  if (isActive(existing)) return existing;

  const job = {
    status: "labelling",
    owner: OWNER,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: { labelled: 0, fromCache: 0, failed: 0, total: null },
    error: null,
  };

  // Claim the slot before the first await. Everything above this point is
  // synchronous, so a second request arriving in the same tick sees the claim
  // and joins rather than starting a rival job — the store write below is too
  // late to serve as the lock, because two callers can both reach it first.
  const claim = { job, promise: null };
  running.set(key, claim);

  const write = () => store.set(key, job, JOB_TTL_SECONDS);
  await write();

  let lastWrite = 0;

  // Deliberately not awaited: the request returns 202 while this continues.
  const promise = (async () => {
    try {
      const result = await run(auth, agentId, {
        onProgress(progress) {
          Object.assign(job.progress, progress);

          // Labelling is the only phase with an observable middle, so the
          // status flips as soon as it is done rather than when the run is.
          // "labelled 340 of 1,240" is a real fraction that moves; "analyzing"
          // for four more minutes is not, and the user deserves to know which
          // one they are looking at.
          const wasLabelling = job.status === "labelling";
          const seen = progress.labelled + progress.fromCache + progress.failed;
          if (seen >= progress.total) {
            job.status = "synthesizing";
          }

          // A status change always writes, throttle or not. Otherwise the last
          // tick of a fast labelling phase is swallowed and the stored record
          // sits at "labelling, 1 of 4" for the several minutes that synthesis
          // then takes.
          if (
            (wasLabelling && job.status === "synthesizing") ||
            Date.now() - lastWrite > PROGRESS_INTERVAL_MS
          ) {
            lastWrite = Date.now();
            write().catch(() => {});
          }
        },
      });

      job.status = "done";
      job.finishedAt = new Date().toISOString();
      job.progress.total = result.coverage.callsScored;
      return result;
    } catch (err) {
      console.error(err);
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      job.error = userFacing(err);
    } finally {
      running.delete(key);
      await write().catch(() => {});
    }
  })();

  claim.promise = promise;

  // Nothing awaits the promise, so an unhandled rejection would take the process
  // down. The catch above already records the failure on the job.
  promise.catch(() => {});

  return job;
}
