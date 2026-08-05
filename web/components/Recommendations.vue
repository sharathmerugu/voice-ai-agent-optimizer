<script setup>
const props = defineProps({ run: Object });

const CATEGORY_LABELS = {
  prompt: "Prompt / script",
  temperature: "Temperature",
  model: "Model",
  actions: "Tools & actions",
  knowledge_base: "Knowledge base / FAQ",
  guardrails: "Guardrails & escalation",
  call_settings: "Call settings",
  follow_up: "Post-call follow-up",
};

const grouped = Object.entries(
  props.run.recommendations.reduce((acc, rec) => {
    (acc[rec.category] ??= []).push(rec);
    return acc;
  }, {}),
);
</script>

<template>
  <p class="muted intro">
    Only categories with supporting evidence are shown — a recommendation with nothing behind it is
    noise, not advice.
  </p>

  <section v-for="[category, recs] in grouped" :key="category" class="group">
    <h2 class="section-title">{{ CATEGORY_LABELS[category] || category }}</h2>

    <div class="card rec" v-for="(rec, i) in recs" :key="i">
      <h3>{{ rec.change }}</h3>
      <p class="rationale">{{ rec.rationale }}</p>
      <blockquote v-if="rec.evidence">{{ rec.evidence }}</blockquote>
      <div class="fixes" v-if="rec.criteriaExpectedToFix?.length">
        <span class="muted">Expected to fix</span>
        <span class="tag tag-neutral" v-for="c in rec.criteriaExpectedToFix" :key="c">{{ c }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.intro {
  margin: 0 0 16px;
}

.group + .group {
  margin-top: 24px;
}

.section-title {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin-bottom: 10px;
}

.rec + .rec {
  margin-top: 10px;
}

.rec h3 {
  font-size: 15px;
}

.rationale {
  margin: 8px 0 0;
}

.fixes {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 12px;
  font-size: 12px;
}
</style>
