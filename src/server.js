import express from "express";

import { authFor, completeInstall } from "./auth.js";
import { listAgents, getAgent } from "./ghl.js";
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
    const locationId = await completeInstall(req.query.code);
    res.send(
      `<body style="font:16px -apple-system,sans-serif;padding:48px;max-width:34rem">
         <h2>Voice AI Agent Optimizer installed</h2>
         <p>Connected to location <code>${locationId}</code>.</p>
         <p>Open the sub-account and choose <strong>Voice AI Optimizer</strong> from the left navigation.</p>
       </body>`,
    );
  }),
);

// The optimizer works on one agent at a time; the first is the demo agent.
app.get(
  "/api/agent",
  wrap(async (req, res) => {
    const auth = await authFor(req.query.locationId);
    const [first] = await listAgents(auth);
    if (!first) return res.status(404).json({ error: "No Voice AI agents in this location." });
    res.json(await getAgent(auth, first.id));
  }),
);

// Returns the stored run unless ?fresh=1 — a full pass is three LLM calls, so the
// page loads instantly and re-runs only on request.
app.post(
  "/api/run/:agentId",
  wrap(async (req, res) => {
    const auth = await authFor(req.query.locationId);
    const cached = req.query.fresh ? null : readRun(auth.locationId);
    res.json(cached ?? (await run(auth, req.params.agentId)));
  }),
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`http://localhost:${port}`));
