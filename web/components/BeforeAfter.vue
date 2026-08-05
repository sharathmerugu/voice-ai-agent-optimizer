<script setup>
import { ref } from "vue";

const props = defineProps({ run: Object });

const before = props.run.baseline.score;
const after = props.run.patched.score;
const copied = ref(false);

function copyPatches() {
  const text = props.run.patches
    .map((p) => `## ${p.section} (${p.operation})\n${p.text}`)
    .join("\n\n");
  navigator.clipboard.writeText(text);
  copied.value = true;
  setTimeout(() => (copied.value = false), 2000);
}
</script>

<template>
  <section class="scores">
    <div class="card score">
      <span class="muted">Before</span>
      <strong>{{ before.passed }}/{{ before.total }}</strong>
      <span class="muted small">criteria passing</span>
    </div>
    <div class="arrow">&rarr;</div>
    <div class="card score after">
      <span class="muted">After</span>
      <strong>{{ after.passed }}/{{ after.total }}</strong>
      <span class="muted small">criteria passing</span>
    </div>
  </section>

  <template v-if="run.flipped.length">
    <h2 class="section-title">Criteria that flipped</h2>
    <div class="card">
      <div class="flip" v-for="(f, i) in run.flipped" :key="i">
        <span class="tag tag-pass">now passing</span>
        <span>{{ f.criterion }}</span>
        <span class="muted small">{{ f.caseName }}</span>
      </div>
    </div>
  </template>

  <template v-if="run.configChanges?.length">
    <h2 class="section-title">Configuration changes in the after score</h2>
    <div class="card">
      <div class="cfg" v-for="(c, i) in run.configChanges" :key="i">
        <span class="tag tag-warn">{{ c.category.replace("_", " ") }}</span>
        <span>{{ c.change }}</span>
      </div>
    </div>
    <p class="muted intro">
      Scored alongside the prompt patches below, so the after figure reflects the whole proposed
      agent — not only its wording.
    </p>
  </template>

  <div class="patch-head">
    <h2 class="section-title">Proposed prompt patches</h2>
    <button class="btn btn-secondary" @click="copyPatches">
      {{ copied ? "Copied" : "Copy patches" }}
    </button>
  </div>
  <p class="muted intro">
    Each patch states what changes, where, and why. Apply them in the agent's HighLevel configuration
    screen — the optimizer recommends, it does not write back.
  </p>

  <div class="card patch" v-for="(p, i) in run.patches" :key="i">
    <div class="patch-meta">
      <span :class="['tag', p.operation === 'add' ? 'tag-pass' : 'tag-warn']">{{ p.operation }}</span>
      <strong>{{ p.section }}</strong>
    </div>
    <pre>{{ p.text }}</pre>
    <p class="muted reason">{{ p.reason }}</p>
  </div>
</template>

<style scoped>
.scores {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 28px;
}

.score {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.score strong {
  font-size: 30px;
}

.score.after strong {
  color: var(--pass);
}

.arrow {
  font-size: 22px;
  color: var(--muted);
}

.small {
  font-size: 12px;
}

.section-title {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin-bottom: 10px;
}

.flip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}

.flip + .flip {
  border-top: 1px solid var(--border);
}

.cfg {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 0;
}

.cfg + .cfg {
  border-top: 1px solid var(--border);
}

.patch-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 28px;
}

.intro {
  margin: 0 0 16px;
}

.patch + .patch {
  margin-top: 10px;
}

.patch-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.reason {
  margin: 10px 0 0;
}
</style>
