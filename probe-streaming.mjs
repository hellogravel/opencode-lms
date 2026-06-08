#!/usr/bin/env node
// Probe whether LMS's /v1/chat/completions (OpenAI-compat) emits reasoning
// content in its streaming response, and compare to what /api/v1/chat
// (LMS-native) emits for the same prompt. Answers the question: do we need
// a custom AI SDK transport to surface reasoning streaming to the TUI, or
// is it already coming through the standard OpenAI-compat path?
//
// Env:
//   LMS_BASE_URL   — required (e.g. http://192.168.1.10:1234)
//   LMS_API_KEY    — optional bearer token
//   LMS_LLM_KEY    — model to probe (default: google/gemma-4-e4b)

import { LMSClient } from "./dist/api-client.js";
import { ModelLifecycle } from "./dist/model-lifecycle.js";

const BASE_URL = process.env.LMS_BASE_URL;
const API_KEY = process.env.LMS_API_KEY;
const LLM_KEY = process.env.LMS_LLM_KEY ?? "google/gemma-4-e4b";

if (!BASE_URL) {
  console.error("LMS_BASE_URL required. Example:");
  console.error("  LMS_BASE_URL=http://192.168.1.10:1234 LMS_API_KEY=sk-... node probe-streaming.mjs");
  process.exit(2);
}

const PROMPT = "What is 47 times 23? Think it through step by step, then give the answer.";

const client = new LMSClient({ baseURL: BASE_URL, apiKey: API_KEY });
const lifecycle = new ModelLifecycle(client);

const weLoaded = [];

async function cleanup() {
  for (const id of weLoaded) {
    try {
      await client.unloadModel(id);
      console.log(`\nUnloaded ${id}`);
    } catch (e) {
      console.warn(`Failed to unload ${id}: ${e.message}`);
    }
  }
}
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

const authHeader = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};

async function ensureLoaded() {
  console.log(`Checking ${LLM_KEY}…`);
  let models;
  try {
    models = await client.getModels();
  } catch (err) {
    throw new Error(`Couldn't reach LM Studio at ${BASE_URL}: ${err.message}`);
  }
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error(`LM Studio at ${BASE_URL} returned no models — is the server running?`);
  }
  const m = models.find((mm) => mm.key === LLM_KEY);
  if (!m) {
    const reasoners = models
      .filter((mm) => mm.capabilities?.reasoning)
      .map((mm) => `  ${mm.key}  (${JSON.stringify(mm.capabilities.reasoning.allowed_options)})`);
    const msg = [
      `Model "${LLM_KEY}" not present on this server.`,
      reasoners.length > 0
        ? `Reasoning-capable models available:\n${reasoners.join("\n")}\n\nRe-run with LMS_LLM_KEY=<key> to pick one.`
        : `No reasoning-capable models found in discovery — this probe needs one to exercise reasoning streaming.`,
    ].join("\n");
    throw new Error(msg);
  }
  if (m.capabilities?.reasoning) {
    console.log(`  capabilities.reasoning.allowed_options = ${JSON.stringify(m.capabilities.reasoning.allowed_options)}`);
    console.log(`  capabilities.reasoning.default        = ${JSON.stringify(m.capabilities.reasoning.default)}`);
  } else {
    console.log(`  WARNING: model does not advertise reasoning capability — probe may not exercise reasoning paths`);
  }
  if (m.loaded_instances.length === 0) {
    console.log(`  loading…`);
    await lifecycle.ensureModelLoaded(BASE_URL, m);
    weLoaded.push(LLM_KEY);
    console.log(`  loaded`);
  } else {
    console.log(`  already loaded`);
  }
}

// ── Probe 1: OpenAI-compatible /v1/chat/completions ──

async function probeOpenAICompat() {
  console.log(`\n=== /v1/chat/completions (what @ai-sdk/openai-compatible uses) ===`);
  const body = {
    model: LLM_KEY,
    messages: [{ role: "user", content: PROMPT }],
    stream: true,
    // LMS's OpenAI-compat endpoint accepts the OpenAI-standard reasoning_effort
    // scale (none|minimal|low|medium|high|xhigh) and does its own mapping to
    // the model's native allowed_options internally. So we send the OpenAI
    // standard here regardless of what the model natively supports.
    reasoning_effort: "medium",
  };

  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.log(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return null;
  }

  const deltaFields = new Set();
  const topLevelFields = new Set();
  let chunkCount = 0;
  let firstChunk = null;
  let firstReasoning = null;
  let firstContent = null;
  let firstToolCall = null;
  let combinedReasoning = "";

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let obj;
      try { obj = JSON.parse(data); } catch { continue; }
      chunkCount++;
      if (chunkCount === 1) firstChunk = obj;
      for (const k of Object.keys(obj)) topLevelFields.add(k);
      const delta = obj?.choices?.[0]?.delta ?? {};
      for (const k of Object.keys(delta)) deltaFields.add(k);
      // OpenAI-extension reasoning field names we know about:
      const r = delta.reasoning_content ?? delta.reasoning ?? delta.thought ?? delta.thinking;
      if (r !== undefined) {
        if (firstReasoning == null) firstReasoning = typeof r === "string" ? r.slice(0, 120) : JSON.stringify(r).slice(0, 120);
        if (typeof r === "string") combinedReasoning += r;
      }
      if (delta.content && firstContent == null) firstContent = String(delta.content).slice(0, 120);
      if (delta.tool_calls && !firstToolCall) firstToolCall = JSON.stringify(delta.tool_calls).slice(0, 200);
    }
  }

  console.log(`Chunks received           : ${chunkCount}`);
  console.log(`Top-level chunk fields    : ${[...topLevelFields].join(", ")}`);
  console.log(`choices[0].delta fields   : ${[...deltaFields].join(", ")}`);
  console.log(`First delta sample        : ${JSON.stringify(firstChunk).slice(0, 300)}`);
  console.log(`First reasoning fragment  : ${firstReasoning ?? "(none)"}`);
  console.log(`First message fragment    : ${firstContent ?? "(none)"}`);
  console.log(`First tool_call delta     : ${firstToolCall ?? "(none)"}`);
  console.log(`Total reasoning bytes     : ${combinedReasoning.length}`);

  const hasReasoning = deltaFields.has("reasoning_content")
    || deltaFields.has("reasoning")
    || deltaFields.has("thought")
    || deltaFields.has("thinking");

  console.log(`\n  → reasoning streams via OpenAI-compat? ${hasReasoning ? "YES" : "NO"}`);
  return { hasReasoning, deltaFields: [...deltaFields] };
}

// ── Probe 2: LMS-native /api/v1/chat (for comparison) ──

async function probeNative() {
  console.log(`\n=== /api/v1/chat (LMS-native; what the plugin's streaming.ts knows) ===`);
  const body = {
    model: LLM_KEY,
    input: [{ type: "text", content: PROMPT }],
    stream: true,
  };

  const res = await fetch(`${BASE_URL}/api/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.log(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return null;
  }

  const eventTypes = new Map(); // type → count
  let firstReasoning = null;
  let combinedReasoning = "";
  let firstMessage = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let currentEvent = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        let obj;
        try { obj = JSON.parse(data); } catch { continue; }
        const t = obj.type ?? currentEvent ?? "unknown";
        eventTypes.set(t, (eventTypes.get(t) ?? 0) + 1);
        if (t === "reasoning.delta") {
          if (firstReasoning == null) firstReasoning = String(obj.content ?? "").slice(0, 120);
          if (typeof obj.content === "string") combinedReasoning += obj.content;
        }
        if (t === "message.delta" && firstMessage == null) firstMessage = String(obj.content ?? "").slice(0, 120);
      }
    }
  }

  const types = [...eventTypes.entries()].map(([t, n]) => `${t}(${n})`).join(", ");
  console.log(`Event types (count)       : ${types}`);
  console.log(`First reasoning fragment  : ${firstReasoning ?? "(none)"}`);
  console.log(`First message fragment    : ${firstMessage ?? "(none)"}`);
  console.log(`Total reasoning bytes     : ${combinedReasoning.length}`);

  const hasReasoning = eventTypes.has("reasoning.start") || eventTypes.has("reasoning.delta");
  console.log(`\n  → reasoning streams via LMS-native?     ${hasReasoning ? "YES" : "NO"}`);
  return { hasReasoning, eventTypes: [...eventTypes.keys()] };
}

// ── Summary ──

try {
  await ensureLoaded();
  const openai = await probeOpenAICompat();
  const native = await probeNative();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`VERDICT`);
  console.log("=".repeat(60));
  if (openai?.hasReasoning) {
    console.log(`The OpenAI-compat path ALREADY streams reasoning content.`);
    console.log(`No custom AI SDK transport needed for reasoning streaming.`);
    console.log(`(Whether OpenCode's renderer surfaces it in the TUI is a`);
    console.log(`separate question — the data is on the wire.)`);
  } else if (native?.hasReasoning) {
    console.log(`Reasoning streams ONLY on the LMS-native /api/v1/chat path,`);
    console.log(`not via /v1/chat/completions. A custom AI SDK transport`);
    console.log(`(replacing @ai-sdk/openai-compatible for lms models) would`);
    console.log(`be required to surface reasoning streaming to the TUI.`);
  } else {
    console.log(`Neither endpoint streamed reasoning for this prompt + model.`);
    console.log(`Possible causes: model didn't reason for this prompt; or the`);
    console.log(`reasoning effort wasn't activated. Try a different prompt or`);
    console.log(`a different reasoning-capable model.`);
  }
} catch (err) {
  console.error("ERROR:", err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
