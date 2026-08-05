<script setup>
import { ref, onMounted } from "vue";
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

const agents = ref([]);
const agentId = ref(null);
const run = ref(null);
const activeTab = ref("scorecard");
const busy = ref(false);
const error = ref("");

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function load(fresh = false) {
  busy.value = true;
  error.value = "";
  run.value = null;
  activeTab.value = "scorecard";
  try {
    run.value = await api(
      `/api/run/${agentId.value}?locationId=${locationId}${fresh ? "&fresh=1" : ""}`,
      { method: "POST" },
    );
  } catch (e) {
    error.value = e.message;
  } finally {
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
    agents.value = await api(`/api/agents?locationId=${locationId}`);
    agentId.value = agents.value[0].id;
  } catch (e) {
    error.value = e.message;
    busy.value = false;
    return;
  }

  load();
});
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
      results below cover the {{ run.transcripts.length }} calls analyzed on
      {{ new Date(run.generatedAt).toLocaleDateString() }}.
      <button class="link" @click="load(true)">Re-run to include them</button>
    </div>

    <div v-if="busy && !run" class="card centered">
      <div class="spinner" />
      <p class="muted">Ingesting transcripts and evaluating the agent…</p>
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
        Analyzed {{ run.transcripts.length }} call transcripts with
        <code>{{ run.model || "an unrecorded model" }}</code>
        on {{ new Date(run.generatedAt).toLocaleString() }}. Scores are not comparable across
        different models.
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
