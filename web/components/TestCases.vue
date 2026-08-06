<script setup>
const props = defineProps({ run: Object });

// Verdicts live on the baseline evaluation; test case definitions live alongside.
const cases = props.run.testCases.map((tc) => ({
  ...tc,
  verdicts: props.run.baseline.cases.find((c) => c.id === tc.id)?.verdicts ?? [],
}));
</script>

<template>
  <p class="muted intro">
    Generated from the agent's own configuration and the failure patterns behind its weakest scores.
    Verdicts marked <span class="tag tag-neutral">observed</span> were measured against a real call;
    <span class="tag tag-neutral">predicted</span> verdicts are inferred from a gap in the agent's
    configuration for a scenario the recorded calls never exercised.
  </p>

  <div class="card case" v-for="tc in cases" :key="tc.id">
    <div class="case-head">
      <h3>{{ tc.name }}</h3>
      <span :class="['tag', tc.type === 'edge' ? 'tag-warn' : 'tag-neutral']">{{ tc.type }} path</span>
    </div>
    <p class="muted scenario">{{ tc.scenario }}</p>

    <div class="verdict" v-for="(v, i) in tc.verdicts" :key="i">
      <div class="verdict-head">
        <span :class="['tag', v.pass ? 'tag-pass' : 'tag-fail']">{{ v.pass ? "PASS" : "FAIL" }}</span>
        <span class="criterion">{{ v.criterion }}</span>
        <span class="tag tag-neutral">{{ v.tag }}</span>
      </div>
      <!-- A passing criterion returns no reason. Nothing needs justifying, and
           asking for one back is generation time the user waits through. -->
      <p class="muted reason" v-if="v.reason">{{ v.reason }}</p>
      <blockquote v-if="v.evidence">{{ v.evidence }}</blockquote>
    </div>
  </div>
</template>

<style scoped>
.intro {
  margin: 0 0 16px;
}

.case + .case {
  margin-top: 12px;
}

.case-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.case-head h3 {
  font-size: 15px;
}

.scenario {
  margin: 6px 0 14px;
}

.verdict {
  border-top: 1px solid var(--border);
  padding-top: 12px;
  margin-top: 12px;
}

.verdict-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.criterion {
  font-weight: 500;
}

.reason {
  margin: 6px 0 0;
}
</style>
