// One AWM-like process for the cross-process election test: computes the fingerprint the
// way ml-worker does, asks the daemon for its stats, prints them, and stays connected
// until stdin closes.
import '../../../src/core/embeddings.js';
import '../../../src/core/reranker.js';
import '../../../src/core/query-expander.js';
import { registeredInferenceConfig } from '../../../src/core/ml-worker.js';
import { configEnv, modelDaemonFingerprint } from '../../../src/core/model-daemon.js';
import { ModelDaemonClient } from '../../../src/core/model-daemon-client.js';

const config = registeredInferenceConfig();
const c = new ModelDaemonClient({ fingerprint: modelDaemonFingerprint(config), spawnEnv: configEnv(config), startTimeoutMs: 60_000 });
const stats = await c.request<{ pid: number }>('stats');
console.log(JSON.stringify({ pid: stats.pid, spawned: c.spawned }));
process.stdin.resume();
process.stdin.on('end', () => { c.close(); process.exit(0); });
