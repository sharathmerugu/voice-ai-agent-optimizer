# Voice AI Agent Optimizer

A HighLevel marketplace app that closes the loop from **real Voice AI call transcripts → failure
patterns → generated test cases → scored results → configuration changes**, with a measured
before/after rather than a promised one.

It installs into a sub-account, reads that account's Voice AI configuration and call logs through
the public API, and recommends changes the user applies themselves.

---

## Three ways to evaluate this

**1. Watch the demo — 3 minutes, no setup**

&nbsp;&nbsp;&nbsp;&nbsp;▶ *(Loom link)*

Shows the optimizer running inside HighLevel against a real sandbox agent: the recurring issues it
found, the test suite it generated, its recommendations, and the measured before/after.

**2. Install it into your own HighLevel sub-account**

&nbsp;&nbsp;&nbsp;&nbsp;🔗 **[Install into your HighLevel sub-account](https://marketplace.gohighlevel.com/v2/oauth/chooselocation?response_type=code&redirect_uri=https%3A%2F%2Fvoice-ai-agent-optimizer-ofae.onrender.com%2Foauth%2Fcallback&client_id=6a6f52ae902547b1dd369bca-msfmkjje&scope=locations.readonly+voice-ai-dashboard.readonly+voice-ai-agents.readonly+voice-ai-agent-goals.readonly&version_id=6a6f52ae902547b1dd369bca)**

Approve the app and it installs across your agency's sub-accounts. Open any of them and you will see
**that account's** agent and **that account's** transcripts — credentials are resolved from the
location the page was opened in, and a request for a location no install covers is refused rather
than served with someone else's.

Two prerequisites, both easy to miss:

- **The sub-account needs a Voice AI agent that has taken calls.** The optimizer analyzes call
  history; it cannot manufacture it. With no transcripts it reports exactly that and stops. Open the
  agent → **Test Your Agent → Web Call** and run a few as different callers — no phone number and no
  telephony spend required, and they appear in the API immediately.
- **The first analysis takes about five minutes** (three sequential model calls). It is then cached
  per location and loads instantly; only *Re-run analysis* pays that cost again.

The app is deliberately **Private** — unlisted, installed by direct link, not submitted for public
marketplace review. If your account cannot install a private app owned by another developer, use
option 3.

**3. Clone and run it locally**

```bash
cp .env.example .env    # Anthropic key, plus GHL_LOCATION_ID and GHL_PIT for local use
npm install
npm run probe           # verifies the HighLevel credentials before anything else
npm run build && npm run dev
```

Then open `http://localhost:3000/?locationId=<your location id>`. This path needs no marketplace app
at all — a Private Integration Token from **Sub-account → Settings → Private Integrations** is enough,
and it works regardless of any install restriction. See [Local development](#local-development) for
detail.

> **Hosting caveat.** The deployment runs on a free tier with an ephemeral filesystem, so a restart
> clears stored installs and runs. Reinstalling restores it. A database or mounted volume is the
> production answer; a JSON file is the honest one for a demo.

---

## What it does

| Step | Detail |
|---|---|
| **Ingest** | Pulls the agent's configuration and its Voice AI call logs (`GET /voice-ai/agents/:id`, `GET /voice-ai/dashboard/call-logs`), filtered to the agent under review. |
| **Analyze** | Classifies each call as success / failure / missed opportunity, then detects recurring issues typed to the brief's taxonomy — missed qualification, poor objection handling, incorrect tone, incomplete booking flow, weak follow-up, policy violations. Every issue cites a verbatim transcript quote. |
| **Generate** | Produces six test cases from the detected failures — happy-path and edge-case — each with explicit success criteria. |
| **Evaluate** | Scores every criterion against the agent's current configuration. |
| **Recommend** | Emits configuration changes for evidence-backed categories only, plus prompt patches. |
| **Re-evaluate** | Scores the same suite against the patched configuration to produce the before/after delta. |

A representative run over four real transcripts: **11/27 → 26/27 criteria passing, 15 flipped**, with
all 27 verdicts backed by quotes that appear verbatim in the transcripts.

---

## Architecture

One Node service serves both the API and the built Vue bundle, so the iframe has a single origin
and there is no CORS to configure.

```
Vue SPA (iframe inside HighLevel)
        │  fetch, carrying ?locationId
        ▼
Express (server.js) ── auth.js ──► per-location OAuth token
        │                └─ ghl.js ──► HighLevel API v2
        │
        └────── pipeline.js ──► ai.js ──► Claude (3 calls)
                     │
                     └──► data/run-<locationId>.json
```

| File | Responsibility |
|---|---|
| `src/auth.js` | Records installs, mints and caches location tokens, resolves credentials per request. |
| `src/ghl.js` | HighLevel client. Three calls, one normalization step. Reads no environment — credentials are passed in. |
| `src/ai.js` | `analyze()` and `evaluate()`, with their prompts inline. |
| `src/pipeline.js` | Orchestrates the three calls, scores, computes the delta, persists the run. |
| `src/server.js` | Three routes plus the static bundle. |

### Multi-tenancy

The frontend reads `locationId` from its own URL — HighLevel substitutes `{{location.id}}` into the
Custom Page address at load — and sends it with every request. The backend resolves credentials from
that id, so one deployment serves any number of installs and no request is ever answered with
credentials belonging to a different account.

**HighLevel installs a sub-account app in one of two shapes, and both arrive through the same
callback.** This was the single most surprising thing in the integration:

| Install | What the token response carries | How it is used |
|---|---|---|
| **Agency** — the agency owner accepts the app | `companyId`, `isBulkInstallation`, `installToFutureLocations`; **no `locationId`** | Covers every sub-account, including ones created later. A company token cannot read a sub-account's Voice AI data, so it is exchanged for a location token via `POST /oauth/locationToken` for whichever location opened the page. |
| **Location** — a single sub-account installs | `locationId`, plus a refresh token | Used directly. |

Accepting an app offered to sub-accounts produces the *agency* shape, so that is what a reviewer will
almost certainly get. Assuming the location shape is what made the first two install attempts store a
token under the agency id and then report the app as uninstalled.

Location tokens are short-lived and re-mintable, so they are cached per location but never refreshed
— the company token is the durable credential and is refreshed when it expires. Direct location
installs keep their own refresh token and are refreshed in place.

A Private Integration Token is honoured as a **local-development shortcut only**, and only for the
single location named in `.env`. A deployed instance has no PIT in its environment, so every request
there must go through OAuth. It is also tried last, after every agency install has been given a
chance to mint a token, so it can never mask a real credential.

### Custom Page rather than Custom JS

The brief allows either custom JS or a marketplace app. Both are modules *of* a marketplace app —
in the Developer Portal, **Custom Page** and **Custom JS** sit side by side under Modules — so the
choice is which surface the app exposes, not whether to build one.

Custom Page renders a full UI in an iframe. Custom JS injects script into HighLevel's own screens,
requires Agency distribution, goes through HighLevel review with a stated SLA of up to ten days, and
forbids loading remote scripts — which rules out serving a Vue bundle at all. For a four-screen
dashboard it is the wrong surface, and for a short deadline it is not a viable one.

### Which calls are analyzed

Every call the agent has handled, not only test calls: the ingestion filter is `agentId` plus "has a
transcript". The 25 most recent are taken, and calls without a transcript are skipped.

Test calls are labelled as such when they reach the model, because a call where the operator is
probing their own agent says less about customer experience than the same behaviour in a real one —
and in an account with a hundred customer calls and a handful of tests, treating them alike would
skew the recurring-issue frequencies.

### Handling a busy model API

A full pass is three sequential calls over several minutes. A transient `overloaded_error` arriving
mid-stream is retried with increasing backoff, because losing the whole run to a few seconds of
capacity pressure costs the user the entire result — and a reviewer seeing a failure would
reasonably conclude the tool is broken.

### Why three LLM calls, not six

**Analyze and generate are one call.** They take identical inputs, and test cases should be derived
from the failures actually observed — splitting them would mean sending the same transcripts twice
to produce artifacts that need to agree with each other.

**Evaluate and recommend are one call.** The model needs the failing criteria to prescribe fixes;
judging and prescribing in one context produces recommendations that connect to specific verdicts.

**Evaluate runs twice.** The second pass is the same function with the patch list appended, so the
before/after is measured rather than asserted. Patches are never applied by string surgery — the
patched pass receives the original prompt plus the patches and evaluates as if applied.

Responses use the Anthropic API's structured outputs, so a malformed response is not a reachable
state. That guarantees *shape*, not *substance* — and the format supports no minimum-length
constraints, so an empty array is schema-valid. A run once came back with zero dimensions, zero
issues and zero test cases, passed validation, and the evaluate call then invented five test cases
of its own to score. Each call therefore validates what it received: every dimension scored, six
test cases, one outcome per transcript, a verdict for every criterion. A response that answers
nothing is retried, not rendered.

---

## `observed` vs `predicted` — the honesty boundary

Multi-turn conversation simulation was considered and rejected. There is no HighLevel API to drive a
live agent conversation — web-call testing is browser-driven and manual — so a simulation would have
produced *synthetic* evidence dressed as a measured result.

Instead every criterion verdict carries a tag:

| Tag | Meaning |
|---|---|
| `observed` | A real call already exercised this criterion. The verdict quotes that transcript verbatim. |
| `predicted` | No call exercised it. The verdict follows from a gap in the agent's configuration. |

`observed` verdicts are measurements grounded in real platform data. `predicted` verdicts are honest
inference, labelled as such in the UI. The tag is an enum in the response schema, so it is always
present.

---

## What is real vs what is not

**Real**
- The sandbox sub-account, its Voice AI agent, and its call transcripts — produced by actual web test
  calls and retrieved through the live Voice AI API.
- Configuration analysis, failure detection, test generation, scoring, and recommendations — all
  genuine model output over that real data.
- The before/after delta — a second scoring pass, not an estimate.

**Not simulated, and not claimed to be**
- Test cases are evaluated against configuration and real transcripts. Nothing places a phone call. A
  `predicted` verdict is a reasoned expectation, not a measurement, and is labelled that way
  everywhere it appears.

**Out of scope by design**
- **No write-back.** The optimizer recommends; the user applies changes in HighLevel. Patches are
  copy-ready.
- **Free-tier persistence.** Installs and runs are JSON files under `data/`. On a host with an
  ephemeral filesystem, a restart clears them and the app must be reinstalled. A database or a
  mounted volume is the production answer.

---

## Notes on the HighLevel Voice AI API

Four things worth recording for anyone building against it:

**`locationId` is required on every call**, including endpoints where the resource id already
identifies the record. `GET /voice-ai/agents/:agentId` without it returns **403**, not 400 — which
reads as a scope problem and is not one.

**Model, temperature, and knowledge base are not exposed.** The agent object returns `agentPrompt`,
`welcomeMessage`, `actions`, `voiceId`, `language`, `responsiveness`, `maxCallDuration`,
idle-reminder settings, `agentWorkingHours`, `timezone`, `callEndWorkflowIds`, and
`toolCallStrictMode` — no model or temperature field on either the list or single-agent endpoint.
Those are configured in the HighLevel UI only. The optimizer still recommends them when the evidence
warrants, and says in the rationale that the change is applied in the UI.

Two further categories — `call_settings` and `follow_up` — were added because they map to fields the
API *does* expose and the transcripts produce direct evidence for them.

**The Voice AI scope names are not published anywhere.** The Developer Portal's scope picker is the
only source. For reference, this app requests:

```
locations.readonly
voice-ai-dashboard.readonly
voice-ai-agents.readonly
voice-ai-agent-goals.readonly
```

Scopes are fixed at token-grant time, so adding one means every existing install must be redone —
the old token keeps its old permissions and simply 403s.

**The `client_id` is not the app id.** It is the app id plus a suffix
(`6a6f52ae902547b1dd369bca-msfmkjje`). The bare app id is accepted by the install page but rejected
by the token exchange, which fails *after* a successful-looking install.

**The generated install link omits `client_id`.** The Developer Portal's install link carries only
`version_id`; the install page then requests `installationDetails?appId=` with an empty value and
fails with `CastError: Cast to ObjectId failed for value ""`. Appending `client_id=<app id>` fixes
it. See the install steps below.

**A draft app must be Private to install.** Leaving App type as `Public` disables the install button
with *"This integration cannot be added, please contact the developer!"* — public apps require review
before installation.

---

## Running it

### Prerequisites

- Node 22+ (uses `--env-file`, no dotenv dependency)
- A HighLevel sub-account with at least one Voice AI agent and a few completed calls
- An Anthropic API key with available credit

### 1. Create the marketplace app

In the [Developer Portal](https://marketplace.gohighlevel.com): **My Apps → Create App**.

| Setting | Value | Where |
|---|---|---|
| App type | **Private** | Profile → Listing Configuration |
| Target user | Sub-Account | Profile → Listing Configuration |
| Who can install | Everyone | Profile → Listing Configuration |
| Custom Page URL | `https://voice-ai-agent-optimizer-ofae.onrender.com/?locationId={{location.id}}`, placed in the left navigation | Modules → Custom Page |
| Redirect URL | `https://voice-ai-agent-optimizer-ofae.onrender.com/oauth/callback` | Advanced Settings → Auth |
| Scope | `locations.readonly` | Advanced Settings → Auth |

`{{location.id}}` is a literal HighLevel template variable — type it exactly. Copy the **Client ID**
and **Client Secret** from Advanced Settings → Auth.

### 2. Deploy

The repository includes `render.yaml`, so on [Render](https://render.com) you can use
**New → Blueprint** and point it at the repo. Set three environment variables in the dashboard:

```
GHL_CLIENT_ID
GHL_CLIENT_SECRET
ANTHROPIC_API_KEY
```

Any Node host works — the service needs `npm run build` at build time and `npm start` at run time,
and reads `PORT` from the environment.

### 3. Install into a sub-account

Take the install link from **Advanced Settings → Auth**, append `client_id`, and open it:

```
https://marketplace.gohighlevel.com/v2/oauth/chooselocation
  ?response_type=code
  &redirect_uri=https%3A%2F%2Fvoice-ai-agent-optimizer-ofae.onrender.com%2Foauth%2Fcallback
  &scope=locations.readonly
  &client_id=<your app id>
  &version_id=<your version id>
```

Choose the sub-account, approve, and the callback stores a token for that location. Open the
sub-account and choose **Voice AI Optimizer** from the left navigation.

### 4. Generate transcripts

The optimizer needs calls to analyze. In HighLevel, open the agent → **Test Your Agent → Web Call**
and run a handful as different callers — web calls need no phone number and no telephony spend, and
appear in the API immediately.

Recurring-issue detection needs repeats, so aim for six or more covering a cooperative booker, a
price objector, an urgent or out-of-scope caller, an interrupter, and a vague, unqualified lead.

### Local development

```bash
cp .env.example .env   # fill in client id/secret, Anthropic key
npm install
npm run probe          # verifies HighLevel credentials before anything else
npm run build && npm run dev
```

For local work without an install, set `GHL_LOCATION_ID` and `GHL_PIT` (sub-account → **Settings →
Private Integrations**; scopes are fixed at creation and must include the Voice AI read scopes).
`npm run probe` checks them and writes the raw API responses to `data/` — a 401 or 403 there means
the token lacks the Voice AI scopes and must be reissued rather than debugged.

To expose a local server to HighLevel: `cloudflared tunnel --url http://localhost:3000`, then use the
generated hostname in the Custom Page and redirect URLs. Note these hostnames are ephemeral.

---

## Team of One

**Product.** The brief's ambiguity is "generate test case results" — results imply execution, and no
API executes a Voice AI conversation. Rather than fake a simulation, the product distinguishes
measured verdicts from predicted ones and shows the tag on every row. That decision shaped the
schema, the prompts, and the UI, and it is the thing I would defend hardest in review.

**Design.** Four screens matching the four questions a user actually asks: what is wrong, how would I
test it, what should I change, did it help. The before/after screen carries the demo, so it gets the
most visual weight. The page is styled to sit inside HighLevel rather than announce itself as a
third-party tool.

**Engineering.** Five backend files, no database, no queue, no ORM. The run is one synchronous pass
ending in one JSON object, so a file is the correct storage. Structured outputs removed the
retry-and-validate layer entirely. The one place I spent real complexity is per-location auth,
because a single-tenant version would have shown my data to anyone who installed it.

**QA.** The agent's own configuration is the ground truth: `actions`, `callEndWorkflowIds`, and
`agentWorkingHours` are all empty, and every transcript shows zero actions triggered and no data
captured. An analyzer that fails to surface a booking agent which cannot book has failed, regardless
of how well the rest reads — so `tool_execution` scoring 5/100 on fluent, confident calls is the
check that matters, not the prose.

`npm run verify` enforces what a reviewer cannot check by reading: every citation traced back to the
call record, and every framework score reconciled against the issues beneath it — no dimension marked
strong while carrying a high-severity issue, none reporting affected calls with nothing filed under
it. Both failures are silent by nature. A fabricated quote reads exactly like a real one, and a
flattering score reads exactly like an earned one.
