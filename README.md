# Voice AI Agent Optimizer

A HighLevel marketplace app that closes the loop from **real Voice AI call transcripts → failure
patterns → generated test cases → scored results → configuration changes**, with a measured
before/after rather than a promised one.

It installs into a sub-account, reads that account's Voice AI configuration and call logs through
the public API, and recommends changes the user applies themselves.

---

## Three ways to evaluate this

**1. Watch the demo — 3 minutes, no setup**

&nbsp;&nbsp;&nbsp;&nbsp;▶ **[Watch the demo](https://www.loom.com/share/6b1ec3cee32e48a39dcaa0fbb956023b)**

Shows the optimizer running inside HighLevel against a real sandbox agent: the recurring issues it
found, the test suite it generated, its recommendations, and the before/after.

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
- **The first analysis takes a few minutes** — every call is read once, then three sequential model
  calls write it up. You can close the page while it runs; it keeps going and the result is waiting
  when you come back. Afterwards it loads instantly, and a re-run only pays to read calls that have
  arrived since.

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

> **Hosting caveat.** Installs and cached analyses are held in Redis, so they survive a restart.
> The free tier still sleeps after inactivity, so the first request after a quiet period waits on a
> cold start.

---

## What it does

| Step | Detail |
|---|---|
| **Ingest** | Pulls the agent's configuration and **every** page of its Voice AI call logs (`GET /voice-ai/agents/:id`, `GET /voice-ai/dashboard/call-logs`), filtered server-side to the agent under review. |
| **Label** | Reads each transcript once with a cheap model and stores a structured verdict: outcome, twelve dimensions, issue types, one quote. Cached against the call id forever, so a call is never read twice. |
| **Aggregate** | Turns those labels into scores and frequencies **in code, with no model**. Every figure on the Scorecard is a count over 100% of the calls rather than a statistic over the recent ones. |
| **Sample** | Picks roughly ten calls worth reading closely: the worst examples of each weak dimension, plus a couple that went well for contrast. |
| **Analyze** | Explains the recurring issues behind the weak scores, typed to the brief's taxonomy — missed qualification, poor objection handling, incorrect tone, incomplete booking flow, weak follow-up, policy violations. Every issue cites a verbatim transcript quote. |
| **Generate** | Produces six test cases from those issues — happy-path and edge-case — each with explicit success criteria. |
| **Evaluate** | Scores every criterion against the agent's current configuration. |
| **Recommend** | Emits configuration changes for evidence-backed categories only, plus prompt patches. |
| **Re-evaluate** | Scores the same suite against the patched configuration to produce the before/after delta. |

The middle three steps are the point. The expensive reasoning no longer scales with the account:
labelling happens once per call ever, aggregation is arithmetic, and the strong model reads ten
transcripts whether the agent has taken twenty calls or twenty thousand.

A representative run over a sandbox agent's four transcripts: **11/22 → 22/22 criteria passing, with
every dimension scored across all four calls** and all verdicts backed by quotes that appear
verbatim in the transcripts.

---

## Architecture

One Node service serves both the API and the built Vue bundle, so the iframe has a single origin
and there is no CORS to configure.

```
Vue SPA (iframe inside HighLevel)
        │  POST to start, GET to poll
        ▼
Express (server.js) ── auth.js ──► per-location OAuth token
        │                └─ ghl.js ──► HighLevel API v2 (all pages)
        │
        └── jobs.js ──► pipeline.js
                            │
              ┌─────────────┼──────────────┬─────────────────┐
              ▼             ▼              ▼                 ▼
         labels.js     aggregate.js    sample.js           ai.js
       Haiku, once     no model —    ~10 worst calls   Sonnet, over the
        per call        arithmetic                     aggregate + sample
              │
              └──► store.js ──► Redis, or per-key files locally
```

| File | Responsibility |
|---|---|
| `src/auth.js` | Records installs, mints and caches location tokens, resolves credentials per request. |
| `src/ghl.js` | HighLevel client. Paginates the call log fully; reads no environment — credentials are passed in. |
| `src/framework.js` | The twelve dimensions, the issue taxonomy, and how a pass rate becomes a status. One definition, four consumers. |
| `src/model.js` | One schema-constrained model call, with fallback, retry and output validation. Shared by the labeller and the synthesizer. |
| `src/labels.js` | Reads one transcript into a structured verdict and caches it against the call id, forever. |
| `src/aggregate.js` | Labels → scores, frequencies, outcome mix. Pure functions, no model. |
| `src/sample.js` | Chooses the handful of calls the strong model actually reads. |
| `src/ai.js` | `analyze()` and `evaluate()`, with their prompts inline. |
| `src/pipeline.js` | Orchestrates label → aggregate → sample → synthesize, scores, computes the delta, caches the run. |
| `src/jobs.js` | Runs an analysis as a background job with single-flight and progress reporting. |
| `src/store.js` | Key-value storage for installs, labels and cached analyses. Redis in production, files locally. |
| `src/server.js` | Five routes plus the static bundle. |

### Multi-tenancy

The frontend reads `locationId` from its own URL — HighLevel substitutes `{{location.id}}` into the
Custom Page address at load — and sends it with every request. The backend resolves credentials from
that id, so one deployment serves any number of installs and no request is ever answered with
credentials belonging to a different account. It does **not** prove the caller is inside that
sub-account — the id arrives as a query parameter and is taken at its word. See
[What is real vs what is not](#what-is-real-vs-what-is-not) for why, and for the Custom Page SSO
exchange that closes it.

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

### Which calls are analyzed — all of them

An earlier version read the fifty most recent transcripts and scored them. Every number it showed
was therefore a sample statistic wearing a fact's clothes: on an agent with 10,000 calls, *"tool
execution fails in 3 of 50 calls"* says nothing about the other 9,950, and because the window was
*recent* rather than representative, a serious failure that stopped happening last week vanished
from the report entirely.

Raising the limit does not fix that. At roughly 750 tokens per transcript, 2,000 calls is about 1.5M
input tokens in a single request — past the context window, and past the output ceiling long before
that, because every issue has to carry verbatim citations.

**The sampling was not the flaw. Presenting a sample as a census was.** So the work is split by how
expensive it is:

- **Every call is read once, by a cheap model.** A transcript is immutable — call `6a709547` yields
  the same reading today, next month, forever — so the reading is cached against the call id with no
  expiry and never computed twice. An account with 10,000 calls pays for that once; the next day's 40
  new calls cost 40 labels and nothing else.
- **The scores are counted, not estimated.** Aggregation over labels is arithmetic: instant, exact,
  and over 100% of the record. Adding a call updates the Scorecard without re-running anything
  expensive.
- **The strong model reads ten transcripts.** Nobody writes a better prompt patch from 10,000
  transcripts than from the ten worst, and the aggregate has already established which those are.

The run reports the split — `{ labelled: 12, fromCache: 1228 }` — so the once-only property is
visible rather than assumed. A non-zero `labelled` on an unchanged account means something is wrong.

A run is capped at `ANALYSIS_MAX_CALLS` (default 500) and the UI says so when it bites. That is a
census of a window rather than an estimate over everything: each of those 500 is read and counted
individually, and the Scorecard says "the 500 most recent of 10,000" rather than implying it saw
them all.

**The window does not crawl backwards.** Each run fetches the newest N, so new calls enter it and
old ones fall out; calls beyond the cap are never read. Raising the cap is currently the only way to
reach further back, and because labels are permanent, raising it only pays for the calls it newly
reaches. Backfilling the rest in the background is the obvious next step and is not built.

Test calls are marked as such throughout, because a call where the operator is probing their own
agent says less about customer experience than the same behaviour in a real one — and in an account
with a hundred customer calls and a handful of tests, treating them alike would skew the frequencies.

### An analysis is a job, not a page load

Nobody watches this run. They open the app, trigger an analysis, leave, and come back — daily,
weekly, monthly — to see how their agents are doing. Once that is the product, the length of the job
stops mattering and the honesty of the progress figure starts to.

`POST /api/run/:agentId` therefore returns `202` immediately with a job record; `GET` returns the
finished run if there is one and the job's status otherwise. The page polls, shows *"labelling call
340 of 1,240"* — a real fraction, because labelling genuinely happens one call at a time — and says
plainly that the page can be closed. Reopening it mid-run picks the job back up rather than serving
the previous analysis.

**Single-flight.** Two people opening the same sub-account must not trigger two analyses: that is
duplicated spend and a race over the same cache keys. An already-running job is returned rather than
duplicated, and the claim is taken synchronously so two requests arriving in the same tick cannot
both win it. A job whose process died — a restart on a free tier, most likely — is reported as
failed rather than left spinning, because the alternative is a progress bar that never moves again.

Push notification to a user who has closed HighLevel entirely is out of scope: it needs a channel
this app does not have and scopes it was not granted.

### Handling a busy model API

Synthesis is three sequential calls over minutes. A transient `overloaded_error` arriving mid-stream
is retried with increasing backoff, because losing the whole run to a few seconds of capacity
pressure costs the user the entire result. Labelling retries less patiently and gives up sooner: with
thousands of calls in flight, one transcript that will not label is cheaper to drop and report than
to wait on, and the run says how many were dropped.

### Storage: key-value, not relational

Nothing here is relational. There are two kinds of record — an install, and a cached analysis — and
both are read whole by a single key. There are no joins, no aggregations and no partial updates, so a
schema and a migration tool would be overhead in exchange for nothing.

`src/store.js` is a small key-value interface with two backends: **Redis when `REDIS_URL` is set**,
per-key files otherwise. Local development therefore needs no infrastructure, and a deployment gets
durability.

Two properties made this worth doing rather than leaving analyses in plain files:

**One key per record, so concurrent writes cannot collide.** An earlier version kept every install in
a single `installs.json`, read, modified and written with network calls in between. Two sub-accounts
refreshing tokens at the same moment would interleave and the second write would silently discard the
first. Keying each install separately removes the shared document, and with it the lost update.

**The cache has to survive a restart to be a cache at all.** An analysis is three model calls and
several minutes. It is computed once per agent and served until the user asks for a fresh one — but
on a free tier the filesystem is wiped whenever the service sleeps, so every visit after a quiet
period would pay for the analysis again, and every user would be told to reinstall an app they
already have.

**Labels are the one thing that must never expire.** `store.set` takes an optional TTL, and it is
deliberately omitted for labels. A location token expires because it genuinely goes stale; a reading
of an immutable transcript cannot. A TTL there would quietly reintroduce the re-processing the whole
design exists to prevent — and it would look like it was working, just getting slowly more
expensive. Minted location tokens, by contrast, carry a TTL matching the token's own lifetime so
they expire rather than accumulating as dead keys.

Labels are keyed by `label:<locationId>:<callId>` — never by run, agent or batch — so re-running the
analysis, or analyzing a different agent in the same account, cannot invalidate them. Only the
transcript-derived part of a label is cached; the verdicts that depend on the agent's configuration
are recomputed each run, because a transcript is immutable and an agent's configuration is not.
Cached labels carry a version, so a change to what a label means invalidates the old ones rather
than silently mixing two vocabularies into one aggregate.

Postgres was considered and rejected: nothing here is relational, and Render's free tier expires
after 30 days — the exact window in which a submission might be revisited.

### Which model does what

| Tier | Model | Why |
|---|---|---|
| Label | `claude-haiku-4-5` | Narrow classification over one transcript — did an action fire, was data captured, did the caller get an answer. Small models are reliable at this, and it sees one transcript per request, so the 200K window is nowhere near a constraint. |
| Synthesize | `claude-sonnet-5` | Writing issue narratives, test cases and recommendations from a pre-computed aggregate plus ten examples. |

**Splitting the work is what makes a larger model unnecessary here.** Previously one model had to
read fifty transcripts, find patterns across them, and write everything up. Now the reading is
Haiku's, the pattern-finding is arithmetic, and the strong model only writes — over a tenth of the
input, producing less output.

Sonnet 5 thinks adaptively at `high` effort by default, and thinking is generated a token at a time
like everything else, so across three sequential calls it sets the wall clock. Running synthesis at
`medium` took a measured run from **367s to 155s** with no visible loss in the narratives or the
suite. `ANTHROPIC_MODEL` and `ANTHROPIC_EFFORT` keep both choices testable rather than baked in.

Labelling is deliberately **not** batched. One request per label is what keeps a label cacheable in
isolation and lets a single failure retry without redoing its neighbours; concurrency, not batching,
is the throughput lever.

### Why three synthesis calls, not six

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
of its own to score. Each call therefore validates what it received: every dimension judged, six
test cases, a verdict on every criterion exactly once. A response that answers nothing is retried,
not rendered.

### The schema is the latency lever

Output tokens are generated one at a time, so they dominate wall-clock; input is processed in
parallel and barely matters. With structured outputs **the schema decides how much gets written**,
which makes trimming it the one speed-up that costs no quality. Three things were being written back
that were already known:

| Waste | Fix |
|---|---|
| Every verdict echoed its criterion back verbatim, in both passes | Return `criterionIndex` into the test case's own list; the text is reattached in code |
| Every verdict carried a `reason`, including the ones that passed | Require it only on failure — a passing criterion needs no justification |
| The patched pass re-emitted full verdicts with evidence for all 30 criteria | It only needs pass/fail to compute the delta, plus a reason for the criteria that *changed* |

The same principle applies to labels, which return a quote only when the call actually failed. At
10,000 calls that is the difference between roughly 2M and 1.2M output tokens on a first backfill.

`max_tokens` stays generous regardless — it is a truncation guard, not a budget, and setting it low
simply breaks long runs. The 32K ceiling truncated this pipeline once already.

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

**And the tag is checked, not trusted.** Before a run is stored, every quote in it — issue evidence,
`observed` verdict evidence, recommendation evidence — is matched against the transcripts it claims
to come from ([`src/cite.js`](src/cite.js)). A quote that does not match costs its claim: an
`observed` verdict is demoted to `predicted` and loses its evidence, an issue that ends up with no
real quote is dropped entirely, and a recommendation keeps its argument but loses the citation. The
count of what was checked and what was withdrawn is stored on the run and shown at the foot of every
screen.

This exists because it caught something. In an earlier run, an `observed` verdict quoted the agent
as offering to *"try a different day"* where the transcript says *"try a different week"* — a
single word, in a quote that read as precise, presented as a measurement. The instruction not to
compose quotes was already in the system prompt; instructions are not a guarantee, and this is the
same rule enforced in code.

The check allows a citation to skip the other speaker's turns (an interruption splits one sentence
across two `bot:` turns) and to join non-adjacent passages across an ellipsis. It does not allow a
reordering, a paraphrase, or an invented syllable.

---

## What is real vs what is not

**Real**
- The sandbox sub-account, its Voice AI agent, and its call transcripts — produced by actual web test
  calls and retrieved through the live Voice AI API.
- Configuration analysis, failure detection, test generation, scoring, and recommendations — all
  genuine model output over that real data.
- Every quote on every screen — machine-checked against the transcript it cites before the run is
  stored, with anything that does not match withdrawn and counted.
- The **before** score — the generated suite scored against the agent's live configuration and its
  real transcripts.

**Counted, not estimated**
- Framework scores and issue frequencies are arithmetic over every labelled call. When the Scorecard
  says an agent failed tool execution in 4 of 4 calls, that is a count of 4, not a model's
  impression of 4. The narrative model is explicitly forbidden from restating frequencies, because
  it sees a deliberate sample and would be guessing.
- The four dimensions that matter most for "does this agent actually work" — tool execution and data
  capture in particular — are decided by fields on the call record rather than by how the call
  reads. An agent that says it booked an appointment while no action was executed fails tool
  execution however fluent it sounded. That is what keeps a twelve-dimension rubric from becoming
  twelve flavours of opinion.
- A dimension no call exercised is `not_evaluated` with no score, never a zero. If nobody asked for
  a human, nothing has been learned about escalation.

**Not simulated, and not claimed to be**
- Test cases are evaluated against configuration and real transcripts. Nothing places a phone call. A
  `predicted` verdict is a reasoned expectation, not a measurement, and is labelled that way
  everywhere it appears.
- **The after score is predicted, and the UI says so on the card.** It is a real second scoring pass
  — the same suite, the same transcripts, the same evaluator — but against a configuration that has
  never taken a call. The honest description is a reasoned expectation of what the changes buy,
  which is the most any tool can offer while no API can drive a Voice AI conversation.

  Three things bound how far that can drift, and none of them make it a measurement:

  - The second pass is anchored to the first, and is asked what changed rather than asked to
    re-derive a reading of the transcripts.
  - Regressions are reported, not only improvements. A screen that can only deliver good news is
    not delivering any.
  - Model and temperature recommendations are deliberately excluded from the second pass. Their
    effect cannot be read off a configuration, so crediting them would be inventing the improvement.
    They appear on the same screen, marked as not counted.

  What would make it a measurement is running the generated cases as real conversations against the
  patched agent and scoring the result. That is the next thing I would build, and it needs a Voice
  AI test API that does not exist today.

**Out of scope by design**
- **The page trusts its own `locationId`, and that is a real gap.** HighLevel substitutes
  `{{location.id}}` into the Custom Page URL and the frontend forwards it; the backend resolves
  credentials for exactly that location and refuses any location no install covers. What it does not
  do is verify that the person asking is inside that sub-account — so anyone who knows a location id
  can request that account's analysis directly from the deployed URL. The fix is HighLevel's Custom
  Page SSO: the iframe requests encrypted user data over `postMessage`, the backend decrypts it with
  the app's SSO key, and the location comes from the decrypted payload rather than from the query
  string. That is the first thing I would add before this served a real customer, and it is left out
  here rather than half-built.
- **No write-back.** The optimizer recommends; the user applies changes in HighLevel. Patches are
  copy-ready.
- **Cold starts.** Installs and cached analyses live in Redis and survive restarts, but a free-tier
  service still sleeps after inactivity, so the first request after a quiet period waits on the
  container starting.

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
fails with `CastError: Cast to ObjectId failed for value ""`. Appending the **Client ID** from
Advanced Settings → Auth — the suffixed one, per the note above — fixes it. See the install steps
below.

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
| Scopes | `locations.readonly`, `voice-ai-dashboard.readonly`, `voice-ai-agents.readonly`, `voice-ai-agent-goals.readonly` | Advanced Settings → Auth |

All four are required. Scopes are fixed at token-grant time, so a missing one cannot be added later
without redoing every install — the old token keeps its old permissions and 403s on the Voice AI
endpoints.


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
  &scope=locations.readonly+voice-ai-dashboard.readonly+voice-ai-agents.readonly+voice-ai-agent-goals.readonly
  &client_id=<your client id>
  &version_id=<your version id>
```

`client_id` is the **Client ID** from Advanced Settings → Auth — the app id plus a suffix, not the
bare app id.

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

### Checking a run against itself

```bash
npm run verify -- data/kv/run__<locationId>__<agentId>.json
```

Three things can go wrong in a way that reads as confident and specific while being false, so all
three are checked mechanically rather than by eye:

1. **A citation that does not appear in the transcript it claims to quote.** A verdict tagged
   `observed` asserts a measurement; a paraphrase or an invented quote makes the whole report
   untrustworthy while reading as precise. The pipeline now applies this same check before storing a
   run, so on a current run this reports clean by construction — it is kept as an outside audit that
   re-derives the corpus from the stored run and assumes nothing about the pipeline having done its
   job, and as the only way to check a run written by an older version.
2. **A framework score that disagrees with the issues filed beneath it** — a dimension scored
   `strong` while carrying a high-severity issue, a score that does not follow from its own pass and
   fail counts, a `not_evaluated` dimension carrying a number anyway.
3. **A narrative describing problems the census says are not there.** This is the failure mode
   created by writing from a sample and counting from the whole, so it is checked directly: an issue
   filed under a dimension the aggregate calls healthy, or narrated while occurring in zero calls,
   fails the run.

It also prints the labelling split, which is where the once-only property shows up: on a re-run of
an unchanged account it must read `labelled 0 of N`.

Environment overrides worth knowing: `ANTHROPIC_MODEL` and `ANTHROPIC_EFFORT` for synthesis,
`LABEL_MODEL` and `LABEL_CONCURRENCY` for the labeller, and `ANALYSIS_MAX_CALLS` for the first-run
cap.

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
