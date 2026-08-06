<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import Scorecard from "./components/Scorecard.vue";
import Dashboard from "./components/Dashboard.vue";
import TestCases from "./components/TestCases.vue";
import Recommendations from "./components/Recommendations.vue";
import BeforeAfter from "./components/BeforeAfter.vue";

const TABS = [
  ["scorecard", "Scorecard", Scorecard],
  ["dashboard", "Dashboard", Dashboard],
  ["tests", "Test Cases", TestCases],
  ["recs", "Recommendations", Recommendations],
  ["diff", "Before vs After", BeforeAfter],
];

// HighLevel substitutes {{location.id}} into the Custom Page URL at load.
const locationId = new URLSearchParams(location.search).get("locationId");

const POLL_MS = 3000;

const agents = ref([]);
const agentId = ref(null);
const run = ref(null);
const job = ref(null);
const activeTab = ref("scorecard");
const busy = ref(false);
const error = ref("");

let timer = null;

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json();
  // 202 is the job still running, not a failure.
  if (!res.ok && res.status !== 202) {
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return { status: res.status, body };
}

// "labelled 340 of 1,240 calls" is a real fraction that moves, because labelling
// happens one call at a time. It is worth more than shaving a minute off the run.
const progress = computed(() => {
  const p = job.value?.progress;
  if (!p?.total) return null;
  return {
    done: p.labelled + p.fromCache + (p.failed ?? 0),
    total: p.total,
    cached: p.fromCache,
  };
});

// Advanced on every poll, so "started 2 min ago" does not sit at "just now" for
// the length of the analysis.
const now = ref(Date.now());

const elapsed = computed(() => {
  if (!job.value?.startedAt) return "";
  const minutes = Math.floor((now.value - new Date(job.value.startedAt)) / 60000);
  return minutes < 1 ? "just now" : `${minutes} min ago`;
});

function stopPolling() {
  clearInterval(timer);
  timer = null;
}

/** Accepts either shape the API returns: a finished run, or a job to poll. */
function receive({ status, body }) {
  if (status === 202) {
    job.value = body.job;
    return false;
  }
  run.value = body;
  job.value = null;
  // A re-run that failed while an older analysis was on file. Both are shown:
  // the results are still true of the calls they covered.
  error.value = body.jobError || "";
  return true;
}

async function poll() {
  try {
    now.value = Date.now();
    const done = receive(await api(`/api/run/${agentId.value}?locationId=${locationId}`));
    if (done) {
      stopPolling();
      busy.value = false;
    }
  } catch (e) {
    stopPolling();
    busy.value = false;
    error.value = e.message;
  }
}

async function load(fresh = false) {
  stopPolling();
  busy.value = true;
  error.value = "";
  run.value = null;
  job.value = null;
  activeTab.value = "scorecard";

  try {
    const done = receive(
      await api(`/api/run/${agentId.value}?locationId=${locationId}${fresh ? "&fresh=1" : ""}`, {
        method: "POST",
      }),
    );
    if (done) return void (busy.value = false);

    timer = setInterval(poll, POLL_MS);
  } catch (e) {
    error.value = e.message;
    busy.value = false;
  }
}

onMounted(async () => {
  if (!locationId) {
    error.value = "No locationId in the page URL. Open this page from inside HighLevel.";
    return;
  }

  busy.value = true;
  try {
    agents.value = (await api(`/api/agents?locationId=${locationId}`)).body;
    agentId.value = agents.value[0].id;
  } catch (e) {
    error.value = e.message;
    busy.value = false;
    return;
  }

  load();
});

onUnmounted(stopPolling);
</script>

<template>
  <div class="page">
    <header>
      <div>
        <h1>Voice AI Agent Optimizer</h1>
        <select
          v-if="agents.length > 1"
          class="agent-picker"
          v-model="agentId"
          :disabled="busy"
          @change="load()"
        >
          <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
        <p class="muted" v-else-if="agents.length">{{ agents[0].name }}</p>
      </div>
      <button class="btn" :disabled="busy || !agentId" @click="load(true)">
        {{ busy ? "Analyzing…" : "Re-run analysis" }}
      </button>
    </header>

    <div v-if="error" class="banner">{{ error }}</div>

    <div v-if="run?.newCallsSince && !busy" class="banner stale">
      {{ run.newCallsSince }} new
      {{ run.newCallsSince === 1 ? "call has" : "calls have" }} come in since this analysis. The
      results below cover the {{ run.coverage.callsScored }} calls scored on
      {{ new Date(run.generatedAt).toLocaleDateString() }}.
      <button class="link" @click="load(true)">Re-run to include them</button>
    </div>

    <div v-if="busy && !run" class="card centered">
      <div class="spinner" />
      <!-- Order matters: once labelling finishes, the progress fraction is still
           truthy at N of N, so the synthesizing case has to be tested first or
           the page reads "labelling" for the several minutes of write-up. -->
      <p v-if="job?.status === 'synthesizing'" class="progress">
        All {{ progress?.total ?? "" }} calls labelled. Writing up the findings…
      </p>
      <p v-else-if="progress" class="progress">
        Labelling call {{ progress.done }} of {{ progress.total }}
        <span class="muted" v-if="progress.cached">
          · {{ progress.cached }} already read on an earlier run
        </span>
      </p>
      <p v-else class="progress">Fetching this agent's calls…</p>

      <p class="muted centered-note">
        Started {{ elapsed }}. You can close this page — the analysis keeps running and the
        results will be here when you come back.
      </p>
    </div>

    <template v-if="run">
      <nav class="tabs">
        <button
          v-for="[id, label] in TABS"
          :key="id"
          :class="['tab', { active: activeTab === id }]"
          @click="activeTab = id"
        >
          {{ label }}
        </button>
      </nav>

      <component :is="TABS.find(([id]) => id === activeTab)[2]" :run="run" />

      <p class="provenance muted">
        Scored across
        <template v-if="run.coverage.capped">
          the {{ run.coverage.callsScored }} most recent of {{ run.coverage.totalCalls }} calls
        </template>
        <template v-else>
          all {{ run.coverage.callsScored }}
          {{ run.coverage.callsScored === 1 ? "call" : "calls" }} this agent has taken
        </template>
        — {{ run.coverage.fromCache }} read on an earlier run,
        {{ run.coverage.labelled }} read for the first time.
        <template v-if="run.coverage.failedToLabel">
          {{ run.coverage.failedToLabel }} could not be read and are excluded.
        </template>
        The deep dive below was written from {{ run.sample.length }} of them, chosen as the most
        revealing, by <code>{{ run.model || "an unrecorded model" }}</code> on
        {{ new Date(run.generatedAt).toLocaleString() }}. Scores are not comparable across
        different models.
        <template v-if="run.citations">
          Every one of the {{ run.citations.checked }} quotes below was checked against the
          transcript it cites before this page was written<template v-if="run.citations.rejected">
            — {{ run.citations.rejected }}
            {{ run.citations.rejected === 1 ? "did not match and was withdrawn" : "did not match and were withdrawn" }}<template
              v-if="run.citations.issuesDropped"
            >, taking {{ run.citations.issuesDropped }}
              {{ run.citations.issuesDropped === 1 ? "issue" : "issues" }} with them</template
            ></template
          >.
        </template>
      </p>
    </template>
  </div>
</template>

<style scoped>
.page {
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px 20px 64px;
}

header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

header p {
  margin: 4px 0 0;
}

.agent-picker {
  margin-top: 6px;
  padding: 5px 8px;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.banner {
  background: var(--fail-bg);
  color: var(--fail);
  border: 1px solid #fecdca;
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-bottom: 16px;
}

.banner.stale {
  background: var(--warn-bg);
  color: var(--warn);
  border-color: #fde68a;
}

.link {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.centered {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 48px;
  text-align: center;
}

.progress {
  margin: 0;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}

.centered-note {
  margin: 0;
  max-width: 30rem;
  font-size: 13px;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 20px;
}

.tab {
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 10px 14px;
  font-size: 14px;
  color: var(--muted);
  cursor: pointer;
}

.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 500;
}

.provenance {
  margin: 28px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}

.provenance code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
}
</style>
