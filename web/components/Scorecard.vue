<script setup>
const props = defineProps({ run: Object });

const GROUPS = [
  {
    title: "Conversation",
    dimensions: [
      ["prompt_adherence", "Prompt adherence"],
      ["intent_recognition", "Intent recognition"],
      ["task_completion", "Task completion"],
      ["conversation_control", "Conversation control"],
      ["loop_avoidance", "Loop avoidance"],
    ],
  },
  {
    title: "Operational",
    dimensions: [
      ["tool_execution", "Tool execution"],
      ["knowledge_grounding", "Knowledge grounding"],
      ["data_capture", "Data capture"],
      ["routing_escalation", "Routing & escalation"],
      ["call_completion", "Call completion & abandonment"],
      ["responsiveness", "Responsiveness & pacing"],
    ],
  },
  { title: "Outcome", dimensions: [["resolution", "Resolution"]] },
];

const STATUS_CLASS = {
  strong: "tag-pass",
  adequate: "tag-neutral",
  weak: "tag-warn",
  failing: "tag-fail",
  not_evaluated: "tag-neutral",
};

const scored = new Map(props.run.analysis.framework.map((d) => [d.dimension, d]));

const issuesFor = (dimension) =>
  props.run.analysis.issuePatterns.filter((p) => p.dimension === dimension);

// Total duration over turns. Shown under Responsiveness as context only — it mixes the
// agent's response time with how long the caller spoke, so it is not a latency figure.
const pacing = (() => {
  const calls = props.run.transcripts;
  if (!calls.length) return null;
  const turns = calls.reduce((n, c) => n + c.transcript.split(/\n(?=bot:|human:)/).length, 0);
  const seconds = calls.reduce((n, c) => n + c.durationSec, 0);
  return turns ? (seconds / turns).toFixed(1) : null;
})();

const groups = GROUPS.map((g) => ({
  ...g,
  cards: g.dimensions
    .map(([id, label]) => ({ id, label, ...scored.get(id) }))
    .filter((card) => card.status),
}));
</script>

<template>
  <p class="muted intro">
    Every agent is scored on the same twelve dimensions, so weaknesses can be compared between agents
    and across runs. Each card lists the issues filed under it — the Dashboard tab holds the
    transcript evidence behind them.
  </p>

  <section v-for="group in groups" :key="group.title" class="group">
    <h2 class="section-title">{{ group.title }}</h2>
    <div class="grid">
      <div
        v-for="card in group.cards"
        :key="card.id"
        :class="['card', 'dim', { muted: card.status === 'not_evaluated' }]"
      >
        <div class="dim-head">
          <h3>{{ card.label }}</h3>
          <span :class="['tag', STATUS_CLASS[card.status]]">
            {{ card.status === "not_evaluated" ? "not evaluated" : card.status }}
          </span>
        </div>

        <div class="metrics" v-if="card.score !== null && card.score !== undefined">
          <strong>{{ card.score }}</strong>
          <span class="muted small">/ 100</span>
          <span class="muted small dot" v-if="card.callsAffected">
            {{ card.callsAffected }} of {{ run.transcripts.length }} calls affected
          </span>
        </div>

        <p class="summary">{{ card.summary }}</p>

        <p class="muted small pacing" v-if="card.id === 'responsiveness' && pacing">
          Pacing, for context: {{ pacing }}s per turn averaged across all calls. Not a latency
          measurement — it includes the caller's own speaking time.
        </p>

        <ul class="issues" v-if="issuesFor(card.id).length">
          <li v-for="issue in issuesFor(card.id)" :key="issue.title">
            <span :class="['tag', issue.severity === 'high' ? 'tag-fail' : 'tag-warn']">
              {{ issue.severity }}
            </span>
            {{ issue.title }}
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.intro {
  margin: 0 0 20px;
}

.group + .group {
  margin-top: 26px;
}

.section-title {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin-bottom: 10px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
}

.dim.muted {
  background: #fafbfc;
}

.dim-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.dim-head h3 {
  font-size: 14px;
}

.metrics {
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin-top: 10px;
}

.metrics strong {
  font-size: 24px;
}

.small {
  font-size: 12px;
}

.dot::before {
  content: "·";
  margin-right: 5px;
}

.summary {
  margin: 8px 0 0;
  font-size: 13px;
}

.pacing {
  margin: 8px 0 0;
  line-height: 1.45;
}

.issues {
  list-style: none;
  margin: 12px 0 0;
  padding: 12px 0 0;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 13px;
}

.issues li {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
</style>
