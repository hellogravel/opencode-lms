#!/usr/bin/env node
// End-to-end probe of opencode-lms against a live LM Studio server.
// Constrained to two specified models; auto-unloads what it loads.
//
// Reads configuration from environment variables:
//   LMS_BASE_URL   — e.g. http://192.168.1.10:1234   (required)
//   LMS_API_KEY    — bearer token if the server has auth enabled (optional)
//   LMS_LLM_KEY    — model id to use for LLM streaming-load tests
//                    (default: google/gemma-4-e4b)
//   LMS_EMBED_KEY  — model id to use for embedding load test
//                    (default: text-embedding-mxbai-embed-large-v1)

import { LMSClient } from "./dist/api-client.js";
import { ModelLifecycle } from "./dist/model-lifecycle.js";
import { discoverAndMapModels } from "./dist/model-discovery.js";
import { detectLMStudio, validateServer } from "./dist/health.js";

const BASE_URL = process.env.LMS_BASE_URL;
const API_KEY = process.env.LMS_API_KEY;
const LLM_KEY = process.env.LMS_LLM_KEY ?? "google/gemma-4-e4b";
const EMBED_KEY = process.env.LMS_EMBED_KEY ?? "text-embedding-mxbai-embed-large-v1";

if (!BASE_URL) {
  console.error("LMS_BASE_URL is required. Example:");
  console.error("  LMS_BASE_URL=http://192.168.1.10:1234 LMS_API_KEY=sk-... node test-live.mjs");
  process.exit(2);
}

const ALLOWED = new Set([LLM_KEY, EMBED_KEY]);

function pass(name) { console.log(`  PASS  ${name}`); }
function fail(name, detail) { console.log(`  FAIL  ${name}\n        ${detail}`); process.exitCode = 1; }
function section(name) { console.log(`\n— ${name} —`); }

const client = new LMSClient({ baseURL: BASE_URL, apiKey: API_KEY });
const lifecycle = new ModelLifecycle(client);
const loadedInstances = []; // for cleanup

async function cleanup() {
  if (loadedInstances.length === 0) return;
  section("Cleanup: unload models we loaded");
  for (const instId of loadedInstances) {
    try {
      await client.unloadModel(instId);
      pass(`Unloaded ${instId}`);
    } catch (err) {
      fail(`Unload ${instId}`, err.message);
    }
  }
}

process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

try {
  // ── 1. Health & detection ──
  section("Health checks");
  if (API_KEY) {
    const healthNoKey = await validateServer(BASE_URL);
    if (!healthNoKey.healthy) pass(`validateServer w/o apiKey → unhealthy (server has auth — expected)`);
    else fail("validateServer w/o apiKey", "server returned healthy without auth — but LMS_API_KEY is set, expected auth required");
  }

  const health = await validateServer(BASE_URL, API_KEY);
  if (health.healthy && health.apiVersion === "v1") pass(`validateServer → healthy, api ${health.apiVersion}, ${health.latency}ms`);
  else fail("validateServer", JSON.stringify(health));

  const detected = await detectLMStudio();
  if (detected) pass(`detectLMStudio → ${detected.baseURL} (LMS only listens on localhost in our setup; expected null here for remote)`);
  else pass("detectLMStudio → null (expected; LMS is on remote host, not 127.0.0.1)");

  // ── 2. getModels (v1 path) ──
  section("getModels (v1)");
  const models = await client.getModels();
  if (Array.isArray(models) && models.length > 0) pass(`Got ${models.length} models`);
  else fail("getModels", "empty or non-array");

  const llmInfo = models.find(m => m.key === LLM_KEY);
  const embedInfo = models.find(m => m.key === EMBED_KEY);
  if (llmInfo) pass(`Found ${LLM_KEY}`);
  else fail("getModels", `${LLM_KEY} not present`);
  if (embedInfo) pass(`Found ${EMBED_KEY}`);
  else fail("getModels", `${EMBED_KEY} not present`);

  // ── 3. discoverAndMapModels ──
  section("discoverAndMapModels");
  const mapped = discoverAndMapModels(models, undefined);
  const mappedLlm = Object.values(mapped).find(m => m.id === LLM_KEY);
  const mappedEmbed = Object.values(mapped).find(m => m.id === EMBED_KEY);

  if (mappedLlm) {
    pass(`Mapped LLM: name="${mappedLlm.name}", reasoning=${mappedLlm.reasoning}, tool_call=${mappedLlm.tool_call}, modalities=${JSON.stringify(mappedLlm.modalities)}, ctx=${mappedLlm.limit?.context}`);
    // Sanity assertions
    if (mappedLlm.reasoning !== true) fail("mappedLlm.reasoning", "gemma-4-e4b has reasoning capability → expected true");
    if (mappedLlm.tool_call !== true) fail("mappedLlm.tool_call", "gemma-4-e4b is trained for tool use → expected true");
    if (!mappedLlm.modalities?.input.includes("image")) fail("mappedLlm.modalities.input", "gemma-4-e4b has vision → expected 'image' in input");
  } else {
    fail("discoverAndMapModels", `${LLM_KEY} missing from mapped output`);
  }

  // Embedding models are intentionally filtered from discovery output —
  // OpenCode has no slot that consumes them, and surfacing them would
  // clutter the chat model picker.
  if (mappedEmbed) {
    fail("discoverAndMapModels", `${EMBED_KEY} should be filtered out of mapped output (embedding models don't belong in OpenCode's picker)`);
  } else {
    pass(`Embedding model correctly filtered from discovery output`);
  }

  // ── 4. ensureModelLoaded (streaming) — embedding model first (smaller) ──
  section(`Streaming load: ${EMBED_KEY}`);
  const before = await client.getModels();
  const embedBefore = before.find(m => m.key === EMBED_KEY);
  if (!embedBefore) {
    fail("embed lookup", `${EMBED_KEY} not present on this server — skipping the embedding load test`);
  } else if (embedBefore.loaded_instances.length > 0) {
    pass("Already loaded — will skip load test for embed");
  } else {
    let progressSeen = 0, loadStart = false, loadEnd = false, errored = null;
    const t0 = Date.now();
    await lifecycle.ensureModelLoaded(BASE_URL, embedBefore, (event) => {
      if (event.type === "model_load.start") loadStart = true;
      else if (event.type === "model_load.progress") progressSeen++;
      else if (event.type === "model_load.end") loadEnd = true;
      else if (event.type === "error") errored = event.error?.message ?? "(no message)";
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(2);

    if (errored) fail("streaming load embed", `stream error: ${errored}`);
    else pass(`Stream completed in ${dt}s (start=${loadStart}, progress_events=${progressSeen}, end=${loadEnd})`);

    // Verify loaded
    const after = await client.getModels();
    const embedAfter = after.find(m => m.key === EMBED_KEY);
    if (embedAfter.loaded_instances.length > 0) {
      pass(`${EMBED_KEY} confirmed loaded post-stream`);
      // Capture instance ID for cleanup. Constrain: only unload models in ALLOWED set.
      for (const inst of embedAfter.loaded_instances) {
        if (ALLOWED.has(embedAfter.key)) loadedInstances.push(inst.id);
      }
    } else {
      fail("post-load check", `${EMBED_KEY} not reported loaded after streaming load`);
    }
  }

  // ── 5. ensureModelLoaded (streaming) — LLM ──
  section(`Streaming load: ${LLM_KEY}`);
  const before2 = await client.getModels();
  const llmBefore = before2.find(m => m.key === LLM_KEY);
  if (!llmBefore) {
    fail("llm lookup", `${LLM_KEY} not present on this server — skipping the streaming load test`);
  } else if (llmBefore.loaded_instances.length > 0) {
    pass("Already loaded — will skip load test for LLM");
  } else {
    let progressSeen = 0, loadStart = false, loadEnd = false, errored = null;
    let chatEnd = false;
    let lastPct = -1;
    const t0 = Date.now();
    await lifecycle.ensureModelLoaded(BASE_URL, llmBefore, (event) => {
      if (event.type === "model_load.start") {
        loadStart = true;
        console.log(`        [event] model_load.start instance=${event.model_instance_id}`);
      } else if (event.type === "model_load.progress") {
        progressSeen++;
        const pct = Math.floor(event.progress * 100);
        if (pct >= lastPct + 20) { // log every 20% in test output
          console.log(`        [event] model_load.progress ${pct}%`);
          lastPct = pct;
        }
      } else if (event.type === "model_load.end") {
        loadEnd = true;
        console.log(`        [event] model_load.end in ${event.load_time_seconds?.toFixed?.(2) ?? "?"}s`);
      } else if (event.type === "chat.end") {
        chatEnd = true;
      } else if (event.type === "error") {
        errored = event.error?.message ?? "(no message)";
      }
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(2);

    if (errored) fail("streaming load LLM", `stream error: ${errored}`);
    else pass(`Stream completed in ${dt}s (start=${loadStart}, progress_events=${progressSeen}, end=${loadEnd}, chat_end=${chatEnd})`);

    const after = await client.getModels();
    const llmAfter = after.find(m => m.key === LLM_KEY);
    if (llmAfter.loaded_instances.length > 0) {
      pass(`${LLM_KEY} confirmed loaded post-stream`);
      for (const inst of llmAfter.loaded_instances) {
        if (ALLOWED.has(llmAfter.key)) loadedInstances.push(inst.id);
      }
    } else {
      fail("post-load check", `${LLM_KEY} not reported loaded after streaming load`);
    }
  }

  // ── 6. Idempotency / context policy: a repeat ensureModelLoaded should
  //       no-op when the resident window covers the (default 32768) policy,
  //       and evict + reload when it doesn't (see model-lifecycle.ts).
  section("Idempotency / context policy");
  const reloaded = await client.getModels();
  const llmReloaded = reloaded.find(m => m.key === LLM_KEY);
  if (!llmReloaded || llmReloaded.loaded_instances.length === 0) {
    fail("idempotency", `${LLM_KEY} not loaded — an earlier load step must have failed`);
  } else {
    const policyCtx = Math.min(32768, llmReloaded.max_context_length); // DEFAULT_CONTEXT_LENGTH
    const residentCtx = Math.max(...llmReloaded.loaded_instances.map(i => i.config.context_length));
    const t0 = Date.now();
    let eventsOnSecondCall = 0;
    await lifecycle.ensureModelLoaded(BASE_URL, llmReloaded, () => { eventsOnSecondCall++; });
    const dt = ((Date.now() - t0) / 1000).toFixed(3);

    if (residentCtx >= policyCtx) {
      if (eventsOnSecondCall === 0) pass(`Second call returned quickly (${dt}s) with 0 events — resident ctx ${residentCtx} ≥ policy ${policyCtx}, short-circuited`);
      else fail("idempotency", `Got ${eventsOnSecondCall} events on second call; resident ctx ${residentCtx} ≥ policy ${policyCtx} should short-circuit`);
    } else {
      // Resident instance predates the policy (e.g. loaded by an older plugin
      // or manually at a small window) — expect an evict + reload at policyCtx.
      const after = (await client.getModels()).find(m => m.key === LLM_KEY);
      const ctxAfter = Math.max(...(after?.loaded_instances.map(i => i.config.context_length) ?? [0]));
      if (ctxAfter >= policyCtx) {
        pass(`Undersized resident instance (ctx ${residentCtx}) reloaded at ${ctxAfter} in ${dt}s`);
        for (const inst of after.loaded_instances) {
          if (ALLOWED.has(after.key)) loadedInstances.push(inst.id);
        }
      } else {
        fail("undersized reload", `resident ctx ${residentCtx} < policy ${policyCtx}, but post-call ctx is ${ctxAfter}`);
      }
    }
  }

} catch (err) {
  console.error("\nFATAL:", err);
  process.exitCode = 1;
} finally {
  await cleanup();
  console.log(process.exitCode ? "\n✗ Some checks failed" : "\n✓ All checks passed");
}
