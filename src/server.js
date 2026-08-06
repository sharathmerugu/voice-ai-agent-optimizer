import express from "express";

import { authFor, completeInstall } from "./auth.js";
import { listAgents, countCalls } from "./ghl.js";
import { readRun } from "./pipeline.js";
import { startJob, readJob } from "./jobs.js";

const app = express();

// The page is embedded in an iframe by HighLevel, so it must not send
// X-Frame-Options. Express sends none by default; this is only worth noting
// because adding a security-header middleware here would break the embed.
app.use(express.static("dist"));

/**
 * Turns a failure into something worth reading.
 *
 * Errors here arrive from three places — HighLevel, the model API, and this
 * app — and only the last is written for a person. An SDK error's `message` is
 * the raw JSON body, which is meaningless to the user looking at the page and
 * says nothing about what they should do next. The detail still goes to the
 * server log, where it is useful.
 */
function userFacing(err) {
  const type = err?.error?.error?.type;

  if (type === "overloaded_error" || err?.status === 529) {
    return "The analysis service is busy right now. This usually clears within a few minutes — try again shortly.";
  }
  if (type === "rate_limit_error" || err?.status === 429) {
    return "Too many analyses at once. Wait a moment and try again.";
  }
  if (type === "authentication_error" || err?.status === 401) {
    return "The analysis service rejected our credentials. This is a configuration problem on our side, not yours.";
  }
  if (err.message?.startsWith("Model returned an unusable response")) {
    return "The analysis came back incomplete and could not be trusted. Try running it again.";
  }
  if (err.message?.startsWith("HighLevel ")) {
    return "HighLevel would not return this agent's data. Check that the app is still installed for this sub-account.";
  }

  // Errors this app raises deliberately — no transcripts, no agents, not
  // installed — are already written for a person.
  return err.message;
}

const wrap = (handler) => (req, res) =>
  handler(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: userFacing(err) });
  });

// HighLevel redirects here after a sub-account installs the app. The code is
// exchanged for a token scoped to that location and stored, which is what makes
// one deployment usable by any installing account.
app.get(
  "/oauth/callback",
  wrap(async (req, res) => {
    // Reached directly rather than via an install; say so instead of surfacing
    // a token-exchange failure.
    if (!req.query.code) {
      return res
        .status(400)
        .send(
          `<body style="font:16px -apple-system,sans-serif;padding:48px;max-width:34rem">
             <h2>Nothing to install</h2>
             <p>This page is the destination HighLevel redirects to after an install. Start from the app's install link instead.</p>
           </body>`,
        );
    }

    const install = await completeInstall(req.query.code);
    const covers =
      install.scope === "company"
        ? `Installed for the agency <code>${install.id}</code>, covering every sub-account.`
        : `Connected to location <code>${install.id}</code>.`;

    res.send(
      `<body style="font:16px -apple-system,sans-serif;padding:48px;max-width:34rem">
         <h2>Voice AI Agent Optimizer installed</h2>
         <p>${covers}</p>
         <p>Open the sub-account and choose <strong>Voice AI Optimizer</strong> from the left navigation.</p>
       </body>`,
    );
  }),
);

// Every Voice AI agent in the location. The optimizer analyzes one at a time, so
// the caller picks which.
app.get(
  "/api/agents",
  wrap(async (req, res) => {
    const auth = await authFor(req.query.locationId);
    const agents = await listAgents(auth);
    if (!agents.length) {
      return res.status(404).json({ error: "No Voice AI agents in this location." });
    }
    res.json(agents);
  }),
);

/**
 * A cached analysis is only current for the calls it covered.
 *
 * Rather than silently serving a stale one — or forcing everyone to wait through
 * a re-analysis they did not ask for — check what has arrived since and let the
 * user decide. Counting the agent's calls is one fast request that reads no
 * transcripts; a re-synthesis is three model calls and minutes.
 */
async function withStaleness(auth, agentId, run) {
  const total = await countCalls(auth, agentId);
  const newCalls = Math.max(0, total - (run.coverage?.totalCalls ?? 0));
  return newCalls ? { ...run, newCallsSince: newCalls } : run;
}

// Two routes over one resource, because an analysis is a job rather than a
// response: POST asks for one, GET asks how it is going. Both return the
// finished run the moment there is one.
//
// 202 means "in progress, poll GET" and carries the job record. The page can be
// closed at any point — the work continues on the server and the result is
// waiting on the next visit.
app.post(
  "/api/run/:agentId",
  wrap(async (req, res) => {
    const auth = await authFor(req.query.locationId);
    const { agentId } = req.params;

    // An already-running job outranks the cached run, and it has to be checked
    // before the cache rather than after. This is the path a returning visitor
    // takes: they triggered a re-run, closed the tab, and came back. Serving
    // them the previous analysis would look like the re-run had finished, and
    // would hide a job that is still going.
    const job = await readJob(auth.locationId, agentId);
    if (job && (job.status === "labelling" || job.status === "synthesizing")) {
      return res.status(202).json({ job });
    }

    if (!req.query.fresh) {
      const cached = await readRun(auth.locationId, agentId);
      if (cached) return res.json(await withStaleness(auth, agentId, cached));
    }

    // Single-flight: an analysis already running for this agent is returned
    // rather than duplicated.
    res.status(202).json({ job: await startJob(auth, agentId, userFacing) });
  }),
);

app.get(
  "/api/run/:agentId",
  wrap(async (req, res) => {
    const auth = await authFor(req.query.locationId);
    const { agentId } = req.params;
    const job = await readJob(auth.locationId, agentId);

    // An active job wins over a cached run: the user asked for a fresh one and
    // is watching it, so showing them the old result would look like the re-run
    // had silently finished.
    if (job && (job.status === "labelling" || job.status === "synthesizing")) {
      return res.status(202).json({ job });
    }

    const run = await readRun(auth.locationId, agentId);

    // A re-run that failed must be reported even when an older analysis is
    // still on file — otherwise the previous results reappear and read as if
    // the re-run had quietly succeeded.
    const failed =
      job?.status === "failed" && (!run || new Date(job.startedAt) > new Date(run.generatedAt));

    if (run) {
      const body = await withStaleness(auth, agentId, run);
      return res.json(failed ? { ...body, jobError: job.error } : body);
    }
    if (failed) return res.status(500).json({ error: job.error });

    res.status(404).json({ error: "No analysis has been run for this agent yet." });
  }),
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`http://localhost:${port}`));
