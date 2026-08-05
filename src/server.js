import express from "express";

import { authFor, completeInstall } from "./auth.js";
import { listAgents } from "./ghl.js";
import { run, readRun } from "./pipeline.js";

const app = express();

// The page is embedded in an iframe by HighLevel, so it must not send
// X-Frame-Options. Express sends none by default; this is only worth noting
// because adding a security-header middleware here would break the embed.
app.use(express.static("dist"));

const wrap = (handler) => (req, res) =>
  handler(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message });
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
    const cached = req.query.fresh ? null : readRun(auth.locationId, req.params.agentId);
    res.json(cached ?? (await run(auth, req.params.agentId)));
  }),
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`http://localhost:${port}`));
