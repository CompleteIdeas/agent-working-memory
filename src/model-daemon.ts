// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Entry point of the shared model daemon (AWM_MODEL_DAEMON=1). Spawned detached by the
 * first AWM process that finds no daemon for its fingerprint; see src/core/model-daemon.ts.
 * It runs the same capped in-process functions an AWM process would run itself, and
 * computes its fingerprint from the config those modules captured, as the client does.
 */

import { startModelDaemon } from './core/model-daemon-server.js';
import { EXIT_FINGERPRINT_DRIFT, modelDaemonFingerprint } from './core/model-daemon.js';
import { registeredInferenceConfig } from './core/ml-worker.js';
import { inProcessEmbed, getEmbedder, EMBED_BATCH_SIZE } from './core/embeddings.js';
import { inProcessRerank, getReranker } from './core/reranker.js';
import { inProcessExpand, getExpander } from './core/query-expander.js';

process.on('uncaughtException', err => {
  console.error(`[model-daemon] uncaught: ${err?.stack ?? err}`);
  process.exit(1);
});

const fingerprint = modelDaemonFingerprint(registeredInferenceConfig());
const expected = process.env.AWM_MODEL_DAEMON_FINGERPRINT;
if (expected && expected !== fingerprint) {
  // The spawner's code or config is not this daemon's (it was rebuilt after the spawner
  // started). Listening anyway would put a daemon on an address nobody asks for.
  console.error(`[model-daemon] spawner expected fingerprint ${expected}, this code is ${fingerprint}: not starting`);
  process.exit(EXIT_FINGERPRINT_DRIFT);
}

startModelDaemon({
  fingerprint,
  handlers: {
    embed: args => inProcessEmbed(args),
    rerank: args => inProcessRerank(args),
    expand: args => inProcessExpand(args),
    warm: async () => { await Promise.all([getEmbedder(), getReranker(), getExpander()]); },
    embedChunk: EMBED_BATCH_SIZE,
  },
}).then(() => {
  // Started by the client's launcher: tell it we listen, so it exits and stops being
  // our parent (see LAUNCHER in model-daemon-client.ts).
  process.send?.({ listening: true }, () => process.disconnect?.());
}, err => {
  // EADDRINUSE: another daemon for this fingerprint won the race. Nothing to do.
  console.error(`[model-daemon] not started: ${(err as Error)?.message ?? err}`);
  process.exit((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE' ? 0 : 1);
});
