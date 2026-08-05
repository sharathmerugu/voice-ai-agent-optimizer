import express from "express";

import { authFor, completeInstall } from "./auth.js";
import { listAgents, listCallLogs } from "./ghl.js";
import { run, readRun } from "./pipeline.js";

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

// Returns the stored run unless ?fresh=1 — a full pass is three LLM calls, so the
// page loads instantly and re-runs only on request.
app.post(
  "/api/run/:agentId",
  wrap(async (req, res) => {
    const auth = await authFor(req.query.locationId);
    const cached = req.query.fresh ? null : await readRun(auth.locationId, req.params.agentId);

    if (!cached) return res.json(await run(auth, req.params.agentId));

    // A cached analysis is only current for the calls it read. Rather than
    // silently serving a stale one — or forcing everyone to wait through a
    // re-analysis they did not ask for — check what has arrived since and let
    // the user decide. Listing call logs is one fast request; re-analyzing is
    // three model calls and several minutes.
    const analyzed = new Set(cached.transcripts.map((t) => t.callId));
    const current = await listCallLogs(auth, req.params.agentId);
    const newCalls = current.filter((c) => !analyzed.has(c.callId)).length;

    res.json(newCalls ? { ...cached, newCallsSince: newCalls } : cached);
  }),
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`http://localhost:${port}`));
