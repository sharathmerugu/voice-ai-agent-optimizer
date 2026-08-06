<script setup>
const props = defineProps({ run: Object });

const OUTCOME_LABELS = {
  success: "Succeeded",
  failure: "Failed",
  missed_opportunity: "Missed opportunity",
};

const SEVERITY_CLASS = { high: "tag-fail", medium: "tag-warn", low: "tag-neutral" };

const counts = Object.keys(OUTCOME_LABELS).map((outcome) => ({
  outcome,
  label: OUTCOME_LABELS[outcome],
  count: props.run.aggregate.outcomes[outcome],
}));
</script>

<template>
  <section class="stats">
    <div class="card stat">
      <span class="muted">Calls scored</span>
      <strong>{{ run.coverage.callsScored }}</strong>
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
    Counted across all {{ run.coverage.callsScored }} scored calls<span
      v-if="run.aggregate.testCalls"
    >
      ({{ run.aggregate.testCalls }} of them test calls)</span
    >, and described from the {{ run.sample.length }} transcripts chosen as the clearest examples.
    Each issue quotes the calls it was found in; the frequency beside it is the count over every
    call, not over the {{ run.sample.length }}.
  </p>

  <div class="card issue" v-for="issue in run.issues" :key="issue.title">
    <div class="issue-head">
      <h3>{{ issue.title }}</h3>
      <div class="tags">
        <span :class="['tag', SEVERITY_CLASS[issue.severity] || 'tag-neutral']">
          {{ issue.severity }} severity
        </span>
        <span class="tag tag-neutral">{{ issue.frequency }} of {{ issue.coverage }} calls</span>
      </div>
    </div>
    <p class="muted type">{{ issue.type }}</p>
    <blockquote v-for="(snippet, i) in issue.evidence" :key="i">{{ snippet }}</blockquote>
  </div>

  <h2 class="section-title sampled">Calls read in full</h2>
  <p class="muted intro">
    Chosen from the {{ run.coverage.callsScored }} scored calls as the most revealing examples of
    the weakest dimensions, plus contrast — not the most recent.
  </p>

  <div class="card sample" v-for="s in run.sample" :key="s.call.callId">
    <div class="issue-head">
      <h3>{{ s.label.reason }}</h3>
      <div class="tags">
        <span
          :class="[
            'tag',
            s.label.outcome === 'success'
              ? 'tag-pass'
              : s.label.outcome === 'failure'
                ? 'tag-fail'
                : 'tag-warn',
          ]"
        >
          {{ OUTCOME_LABELS[s.label.outcome] }}
        </span>
        <span class="tag tag-neutral">{{ s.call.durationSec }}s</span>
      </div>
    </div>
    <p class="muted type">Selected as {{ s.why }}</p>
    <blockquote v-if="s.label.keyQuote">{{ s.label.keyQuote }}</blockquote>
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

.issue + .issue,
.sample + .sample {
  margin-top: 12px;
}

.sampled {
  margin-top: 30px;
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
