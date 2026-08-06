// One schema-constrained model call, with fallback and retry.
//
// Shared by the labeller and the synthesizer because they need the same
// guarantees for different reasons: labelling makes thousands of cheap calls
// where a single transient failure must not poison a run, and synthesis makes
// three expensive sequential ones where losing the third wastes the first two.
//
// Responses are checked for substance as well as shape — an empty answer is
// schema-valid and must not reach the user as a result.
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// The SDK retries a request that fails before the stream opens; an overload
// arriving mid-stream surfaces here instead.
const transient = (err) =>
  err?.error?.error?.type === "overloaded_error" ||
  err?.status === 429 ||
  err?.status >= 500 ||
  err.message?.startsWith("Model returned an unusable response");

/**
 * Runs one call, preferring the first model and degrading to the next when one
 * is unavailable. `usedModels` collects what actually answered, so a run can
 * record it — scores from different models are not comparable.
 */
export async function complete({ models, attempts = 3, usedModels, ...args }) {
  let lastError;

  for (const model of models) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result = await streamOnce({ ...args, model });
        usedModels?.add(model);
        return result;
      } catch (err) {
        if (!transient(err)) throw err;
        lastError = err;

        // Back off before retrying the same model; an overload lasting seconds
        // and one lasting a minute cost the same lost run if we give up early.
        if (attempt < attempts) await new Promise((r) => setTimeout(r, attempt * 15000));
      }
    }
    console.warn(`${model} unavailable after ${attempts} attempts; trying the next model`);
  }

  throw lastError;
}

async function streamOnce({ system, prompt, schema, model, maxTokens, effort, validate }) {
  const stream = client.messages.stream({
    model,
    // A truncation guard, not a budget. Thinking counts against this ceiling
    // too, and 32k truncated the synthesis pass once the framework was added.
    // What actually bounds the output is the schema.
    max_tokens: maxTokens ?? 64000,
    system,
    output_config: {
      format: { type: "json_schema", schema },
      // Sonnet 5 thinks adaptively unless told otherwise, and thinking is
      // generated a token at a time like everything else — so on a run of three
      // sequential calls it sets the wall clock. Effort is the lever for that.
      // Omitted for the labeller: Haiku rejects the parameter outright.
      ...(effort && { effort }),
    },
    messages: [{ role: "user", content: prompt }],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "max_tokens") {
    throw new Error("Model response was truncated.");
  }

  const text = message.content.find((block) => block.type === "text")?.text;
  if (!text) throw new Error(`Model returned no text (stop_reason: ${message.stop_reason})`);

  const result = JSON.parse(text);

  // Structured outputs guarantee the response matches the schema, not that it
  // says anything. Empty arrays are schema-valid, and the format supports no
  // minimum-length constraints — so "did it actually answer" is checked here. A
  // run returning no findings and no test cases would otherwise be presented as
  // a result.
  const problem = validate?.(result);
  if (problem) throw new Error(`Model returned an unusable response: ${problem}`);

  return result;
}
