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

/**
 * The most recent calls for one agent, newest first.
 *
 * Bounded deliberately. Recurring-issue detection needs enough calls to
 * establish frequency, not every call ever taken: an agent with 2,000
 * transcripts would cost roughly 1.5M input tokens per model call, exceed the
 * output ceiling once every issue has to be cited, and take far longer than
 * anyone will wait. Fifty recent calls carry the signal; the count of what
 * exists is returned alongside so the analysis can say what it covered.
 */
export async function listCallLogs(auth, agentId, limit = 50) {
  // agentId filters server-side. Fetching a page of the location's calls and
  // filtering here would mean an agent whose calls are older than that page
  // returns nothing — on a busy account, an agent with hundreds of calls would
  // report as having none.
  const { callLogs, total } = await get(auth, "/voice-ai/dashboard/call-logs", {
    agentId,
    pageSize: String(limit),
  });

  const transcripts = callLogs
    .filter((c) => c.transcript)
    .map((c) => ({
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
    }));

  // `total` is every call this agent has taken; `transcripts` is the window
  // analyzed. They differ on a busy agent, and the UI says so rather than
  // implying the analysis covered everything.
  return { transcripts, totalCalls: total ?? transcripts.length };
}
