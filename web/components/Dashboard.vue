<script setup>
const props = defineProps({ run: Object });

const OUTCOME_LABELS = {
  success: "Succeeded",
  failure: "Failed",
  missed_opportunity: "Missed opportunity",
};

const SEVERITY_CLASS = { high: "tag-fail", medium: "tag-warn", low: "tag-neutral" };

const testCallCount = props.run.transcripts.filter((t) => t.isTestCall).length;

const counts = Object.keys(OUTCOME_LABELS).map((outcome) => ({
  outcome,
  label: OUTCOME_LABELS[outcome],
  count: props.run.analysis.callOutcomes.filter((c) => c.outcome === outcome).length,
}));
</script>

<template>
  <section class="stats">
    <div class="card stat">
      <span class="muted">Transcripts analyzed</span>
      <strong>{{ run.transcripts.length }}</strong>
    </div>
    <div class="card stat" v-for="c in counts" :key="c.outcome">
      <span class="muted">{{ c.label }}</span>
      <strong>{{ c.count }}</strong>
    </div>
    <div class="card stat">
      <span class="muted">Baseline suite score</span>
      <strong>{{ run.baseline.score.passed }}/{{ run.baseline.score.total }}</strong>
    </div>
  </section>

  <h2 class="section-title">Recurring issues</h2>
  <p class="muted intro">
    Detected across {{ run.transcripts.length }} Voice AI call transcripts<span v-if="testCallCount">
      ({{ testCallCount }} of them test calls)</span
    >. Each issue quotes the calls it was found in.
  </p>

  <div class="card issue" v-for="issue in run.analysis.issuePatterns" :key="issue.title">
    <div class="issue-head">
      <h3>{{ issue.title }}</h3>
      <div class="tags">
        <span :class="['tag', SEVERITY_CLASS[issue.severity] || 'tag-neutral']">
          {{ issue.severity }} severity
        </span>
        <span class="tag tag-neutral">{{ issue.frequency }} of {{ run.transcripts.length }} calls</span>
      </div>
    </div>
    <p class="muted type">{{ issue.type }}</p>
    <blockquote v-for="(snippet, i) in issue.evidence" :key="i">{{ snippet }}</blockquote>
  </div>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 28px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.stat strong {
  font-size: 24px;
}

.section-title {
  font-size: 16px;
}

.intro {
  margin: 4px 0 14px;
}

.issue + .issue {
  margin-top: 12px;
}

.issue-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.issue-head h3 {
  font-size: 15px;
}

.tags {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.type {
  margin: 4px 0 0;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
</style>
