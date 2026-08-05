<script setup>
import { ref, onMounted } from "vue";
import Dashboard from "./components/Dashboard.vue";
import TestCases from "./components/TestCases.vue";
import Recommendations from "./components/Recommendations.vue";
import BeforeAfter from "./components/BeforeAfter.vue";

const TABS = [
  ["dashboard", "Dashboard", Dashboard],
  ["tests", "Test Cases", TestCases],
  ["recs", "Recommendations", Recommendations],
  ["diff", "Before vs After", BeforeAfter],
];

// HighLevel substitutes {{location.id}} into the Custom Page URL at load.
const locationId = new URLSearchParams(location.search).get("locationId");

const agent = ref(null);
const run = ref(null);
const activeTab = ref("dashboard");
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
  try {
    agent.value ??= await api(`/api/agent?locationId=${locationId}`);
    run.value = await api(
      `/api/run/${agent.value.id}?locationId=${locationId}${fresh ? "&fresh=1" : ""}`,
      { method: "POST" },
    );
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  if (!locationId) {
    error.value = "No locationId in the page URL. Open this page from inside HighLevel.";
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
        <p class="muted" v-if="agent">{{ agent.name }}</p>
      </div>
      <button class="btn" :disabled="busy || !agent" @click="load(true)">
        {{ busy ? "Analyzing…" : "Re-run analysis" }}
      </button>
    </header>

    <div v-if="error" class="banner">{{ error }}</div>

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

.banner {
  background: var(--fail-bg);
  color: var(--fail);
  border: 1px solid #fecdca;
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-bottom: 16px;
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
</style>
