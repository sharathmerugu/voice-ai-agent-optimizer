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
 * Call logs for one agent, newest first.
 *
 * The endpoint is location-scoped rather than agent-scoped, so calls belonging
 * to other agents in the same sub-account come back too and are filtered here.
 */
export async function listCallLogs(auth, agentId, limit = 25) {
  const { callLogs } = await get(auth, "/voice-ai/dashboard/call-logs", {
    pageSize: String(limit),
  });

  return callLogs
    .filter((c) => c.agentId === agentId && c.transcript)
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
}
