// HighLevel API v2 client.
//
// Every call is made with the credentials of the location that opened the page,
// passed in as `auth` — see auth.js. Nothing here reads the environment, so one
// deployment can serve many installed sub-accounts.
//
// locationId is required as a query parameter on every endpoint, including ones
// where the resource id already identifies the record. Omitting it returns 403,
// not 400, which reads misleadingly like a scope problem.
const BASE = "https://services.leadconnectorhq.com";

async function get(auth, path, params = {}) {
  const query = new URLSearchParams({ locationId: auth.locationId, ...params });
  const res = await fetch(`${BASE}${path}?${query}`, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`HighLevel ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/**
 * The Voice AI agent, reduced to the fields that describe its behaviour.
 *
 * Note that this API exposes no model, temperature, or knowledge base field —
 * those are configured in the HighLevel UI and are not readable here. See the
 * README for how that shapes the recommendations.
 */
export async function getAgent(auth, agentId) {
  const a = await get(auth, `/voice-ai/agents/${agentId}`);
  return {
    id: a.id,
    name: a.agentName,
    businessName: a.businessName,
    welcomeMessage: a.welcomeMessage,
    prompt: a.agentPrompt,
    actions: a.actions ?? [],
    voiceId: a.voiceId,
    language: a.language,
    responsiveness: a.responsiveness,
    maxCallDuration: a.maxCallDuration,
    idleReminders: a.sendUserIdleReminders,
    idleReminderSeconds: a.reminderAfterIdleTimeSeconds,
    workingHours: a.agentWorkingHours ?? [],
    timezone: a.timezone,
    postCallWorkflows: a.callEndWorkflowIds ?? [],
  };
}

export async function listAgents(auth) {
  const { agents } = await get(auth, "/voice-ai/agents");
  return agents.map((a) => ({ id: a.id, name: a.agentName }));
}

// The endpoint rejects anything larger with a 422, so this is a hard ceiling
// rather than a tuning choice: `{"message":["pageSize cannot exceed 50"]}`.
const PAGE_SIZE = 50;

/**
 * How many calls this agent has taken, without fetching any of them.
 *
 * The staleness check runs on every page load and must stay one fast request.
 * Paginating the whole history to discover that nothing has changed would make
 * opening the page cost more than it saves.
 */
export async function countCalls(auth, agentId) {
  const { total, callLogs } = await get(auth, "/voice-ai/dashboard/call-logs", {
    agentId,
    page: "1",
    pageSize: "1",
  });
  return total ?? callLogs?.length ?? 0;
}

function normalizeCall(c) {
  return {
    callId: c.id,
    createdAt: c.createdAt,
    durationSec: c.duration,
    summary: c.summary,
    transcript: c.transcript,
    // Empty in both cases below is itself evidence: the agent can confirm a
    // booking in conversation while having triggered no action and collected
    // no data.
    actionsExecuted: c.executedCallActions ?? [],
    dataCollected: c.extractedData ?? {},
    transferred: c.agentTransferOccurred,
    isTestCall: c.trialCall,
  };
}

/**
 * Every call this agent has taken, newest first.
 *
 * Fetching all of them used to be impossible: fifty transcripts was already near
 * what one model call could read, so the list was bounded and every number the
 * app showed was a statistic over the most recent window presented as a fact
 * about the agent. Labelling changed that — a transcript is now read once by a
 * cheap model and its label cached forever, so the corpus size no longer sets
 * the size of any single request.
 *
 * `limit` caps a first run on a very large account. The labelling of the rest is
 * incremental by construction, so a capped run is a partial census rather than a
 * biased sample, and `totalCalls` reports what exists either way.
 *
 * agentId filters server-side. Fetching a page of the location's calls and
 * filtering here would mean an agent whose calls are older than that page
 * returns nothing — on a busy account, an agent with hundreds of calls would
 * report as having none.
 */
export async function listCallLogs(auth, agentId, limit = Infinity) {
  const transcripts = [];
  let total = 0;

  for (let page = 1; ; page++) {
    const body = await get(auth, "/voice-ai/dashboard/call-logs", {
      agentId,
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });

    const callLogs = body.callLogs ?? [];
    total = body.total ?? total;

    // A call with no transcript carries no evidence — it is counted in `total`
    // but there is nothing to label.
    transcripts.push(...callLogs.filter((c) => c.transcript).map(normalizeCall));

    // Stop on a short page as well as on the reported total: `total` is the
    // count of the agent's calls, and a page that comes back smaller than asked
    // for is the last one regardless of what the count says.
    if (callLogs.length < PAGE_SIZE) break;
    if (transcripts.length >= limit) break;
    if (total && page * PAGE_SIZE >= total) break;
  }

  return {
    transcripts: transcripts.slice(0, limit === Infinity ? undefined : limit),
    // Every call this agent has taken, including any without a transcript, so
    // the UI can say how much of the record the analysis reached.
    totalCalls: Math.max(total, transcripts.length),
  };
}
