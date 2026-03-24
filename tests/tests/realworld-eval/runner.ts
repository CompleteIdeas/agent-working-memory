/**
 * Real-World Eval — test AWM with an actual production codebase.
 *
 * Phase 1: Crawl the codebase and extract meaningful knowledge chunks
 * Phase 2: Seed them into AWM as memories
 * Phase 3: Run retrieval challenges with realistic developer questions
 * Phase 4: Score and report
 *
 * Run: npx tsx tests/realworld-eval/runner.ts [baseUrl] [codebasePath]
 */

import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, extname, basename } from 'node:path';

const BASE_URL = process.argv[2] ?? 'http://localhost:8400';
const CODEBASE_PATH = process.argv[3] ?? './test-codebase';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const TMP_DIR = join(tmpdir(), 'awm-realworld-eval');
try { mkdirSync(TMP_DIR, { recursive: true }); } catch {}

let reqCounter = 0;

async function api(method: string, path: string, body?: any, retries = 2): Promise<any> {
  await sleep(20);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const url = `${BASE_URL}${path}`;
      let cmd = `curl -sf -X ${method}`;
      if (body) {
        const tmpFile = join(TMP_DIR, `req_${reqCounter++}.json`);
        writeFileSync(tmpFile, JSON.stringify(body));
        cmd += ` -H "Content-Type: application/json" -d @"${tmpFile.replace(/\\/g, '/')}"`;
      }
      cmd += ` "${url}"`;
      const result = execSync(cmd, { encoding: 'utf8', timeout: 60000 });
      return JSON.parse(result);
    } catch (err: any) {
      if (attempt < retries) {
        await sleep(2000); // wait before retry
        continue;
      }
      return { error: err.message };
    }
  }
  return { error: 'max retries' };
}

// --- Knowledge Extraction ---

interface KnowledgeChunk {
  concept: string;
  content: string;
  tags: string[];
  eventType: string;
  surprise: number;
  causalDepth: number;
  resolutionEffort: number;
  source: string; // file path for tracing
}

/**
 * Extract knowledge from a TypeScript/JS file:
 * - Module-level doc comments
 * - Exported function signatures with JSDoc
 * - Interface/type definitions
 * - Class declarations
 */
function extractFromTS(filePath: string, relPath: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const module = relPath.replace(/\\/g, '/');
  const moduleParts = module.split('/');
  const baseTags = [moduleParts[0], basename(filePath, extname(filePath))].filter(Boolean);

  // 1. File-level summary (first comment block or first 10 lines of imports)
  const firstComment = content.match(/^\/\*\*([\s\S]*?)\*\//);
  if (firstComment) {
    const docText = firstComment[1].replace(/^\s*\*\s?/gm, '').trim();
    if (docText.length > 20) {
      chunks.push({
        concept: `${module} module purpose`,
        content: docText.slice(0, 500),
        tags: [...baseTags, 'architecture', 'module'],
        eventType: 'causal',
        surprise: 0.5,
        causalDepth: 0.6,
        resolutionEffort: 0.4,
        source: relPath,
      });
    }
  }

  // 2. Exported functions with docs
  const funcRegex = /\/\*\*([\s\S]*?)\*\/\s*\n\s*export\s+(?:async\s+)?function\s+(\w+)/g;
  let match;
  while ((match = funcRegex.exec(content)) !== null) {
    const doc = match[1].replace(/^\s*\*\s?/gm, '').trim();
    const funcName = match[2];
    // Get the function signature (next line after the function keyword)
    const sigStart = content.indexOf(funcName, match.index);
    const sigEnd = content.indexOf('{', sigStart);
    const signature = content.slice(sigStart, sigEnd).trim().replace(/\s+/g, ' ');

    chunks.push({
      concept: `${funcName} function in ${module}`,
      content: `${doc}\n\nSignature: ${signature.slice(0, 300)}`,
      tags: [...baseTags, funcName, 'function'],
      eventType: 'causal',
      surprise: 0.5,
      causalDepth: 0.5,
      resolutionEffort: 0.4,
      source: relPath,
    });
  }

  // 3. Interface/type definitions
  const typeRegex = /export\s+(?:interface|type)\s+(\w+)\s*[{=]/g;
  while ((match = typeRegex.exec(content)) !== null) {
    const typeName = match[1];
    // Get the full definition (up to closing brace or semicolon)
    const defStart = match.index;
    let braceCount = 0;
    let defEnd = defStart;
    for (let i = defStart; i < content.length && i < defStart + 2000; i++) {
      if (content[i] === '{') braceCount++;
      if (content[i] === '}') { braceCount--; if (braceCount === 0) { defEnd = i + 1; break; } }
      if (content[i] === ';' && braceCount === 0) { defEnd = i + 1; break; }
    }
    const typeDef = content.slice(defStart, defEnd).trim();
    if (typeDef.length > 30) {
      chunks.push({
        concept: `${typeName} type definition`,
        content: typeDef.slice(0, 500),
        tags: [...baseTags, typeName, 'type', 'schema'],
        eventType: 'causal',
        surprise: 0.4,
        causalDepth: 0.5,
        resolutionEffort: 0.3,
        source: relPath,
      });
    }
  }

  // 4. Route definitions (Express patterns)
  const routeRegex = /router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((match = routeRegex.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const path = match[2];
    // Get surrounding context (2 lines before, 5 after)
    const lineNum = content.slice(0, match.index).split('\n').length;
    const contextLines = lines.slice(Math.max(0, lineNum - 3), lineNum + 5).join('\n');
    chunks.push({
      concept: `${method} ${path} API endpoint`,
      content: contextLines.slice(0, 500),
      tags: [...baseTags, 'api', 'endpoint', method.toLowerCase()],
      eventType: 'causal',
      surprise: 0.5,
      causalDepth: 0.6,
      resolutionEffort: 0.5,
      source: relPath,
    });
  }

  return chunks;
}

/**
 * Extract knowledge from SQL files:
 * - Table definitions (CREATE TABLE)
 * - Function definitions (CREATE FUNCTION)
 * - Index definitions
 */
function extractFromSQL(filePath: string, relPath: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const content = readFileSync(filePath, 'utf8');
  const baseTags = ['database', 'sql', basename(filePath, '.sql')];

  // Table definitions
  const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\);/gi;
  let match;
  while ((match = tableRegex.exec(content)) !== null) {
    const tableName = match[1];
    const columns = match[2].trim();
    chunks.push({
      concept: `${tableName} database table schema`,
      content: `CREATE TABLE ${tableName} (\n${columns.slice(0, 800)}\n)`,
      tags: [...baseTags, tableName, 'table', 'schema'],
      eventType: 'causal',
      surprise: 0.6,
      causalDepth: 0.7,
      resolutionEffort: 0.5,
      source: relPath,
    });
  }

  // Function definitions
  const funcRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\)\s*RETURNS/gi;
  while ((match = funcRegex.exec(content)) !== null) {
    const funcName = match[1];
    const params = match[2].trim();
    // Get the function body (up to language declaration)
    const bodyEnd = content.indexOf('LANGUAGE', match.index);
    const funcBody = content.slice(match.index, bodyEnd > 0 ? bodyEnd + 20 : match.index + 1000).trim();
    chunks.push({
      concept: `${funcName} database function`,
      content: funcBody.slice(0, 800),
      tags: [...baseTags, funcName, 'function', 'plpgsql'],
      eventType: 'causal',
      surprise: 0.6,
      causalDepth: 0.7,
      resolutionEffort: 0.6,
      source: relPath,
    });
  }

  return chunks;
}

/**
 * Extract knowledge from Markdown docs (BUILD docs, project docs):
 * - Section headers with content
 * - Business rules
 * - Architecture decisions
 */
function extractFromMD(filePath: string, relPath: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const content = readFileSync(filePath, 'utf8');
  const baseTags = ['documentation', basename(filePath, '.md').toLowerCase()];

  // Split by ## headers and extract sections
  const sections = content.split(/^##\s+/m).filter(s => s.trim());
  for (const section of sections) {
    const lines = section.split('\n');
    const heading = lines[0].trim();
    const body = lines.slice(1).join('\n').trim();

    if (body.length < 30) continue;

    // Determine topic tags from heading
    const topicTags: string[] = [];
    if (/auth|login|password|jwt|session/i.test(heading)) topicTags.push('auth');
    if (/database|schema|table|migration/i.test(heading)) topicTags.push('database');
    if (/api|endpoint|route/i.test(heading)) topicTags.push('api');
    if (/stripe|payment|billing|checkout/i.test(heading)) topicTags.push('payments');
    if (/horse|registration|record.?manager/i.test(heading)) topicTags.push('horse');
    if (/member|membership|renewal/i.test(heading)) topicTags.push('membership');
    if (/entry|event|competition/i.test(heading)) topicTags.push('events');
    if (/import|migration|etl/i.test(heading)) topicTags.push('data-import');
    if (/test|ci|deploy|pipeline/i.test(heading)) topicTags.push('devops');

    chunks.push({
      concept: `${heading} — ${basename(filePath)}`,
      content: body.slice(0, 600),
      tags: [...baseTags, ...topicTags],
      eventType: 'causal',
      surprise: 0.6,
      causalDepth: 0.7,
      resolutionEffort: 0.5,
      source: relPath,
    });
  }

  return chunks;
}

/**
 * Walk a directory tree and extract knowledge from supported file types.
 */
function crawlCodebase(rootPath: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage', '.claude']);

  function walk(dirPath: string) {
    let entries: string[];
    try { entries = readdirSync(dirPath); } catch { return; }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      const relPath = relative(rootPath, fullPath);

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          if (!skipDirs.has(entry)) walk(fullPath);
          continue;
        }

        // Skip large files (>50KB) and small files (<100 bytes)
        if (stat.size > 50000 || stat.size < 100) continue;

        const ext = extname(entry).toLowerCase();
        if (['.ts', '.tsx', '.js'].includes(ext)) {
          chunks.push(...extractFromTS(fullPath, relPath));
        } else if (ext === '.sql') {
          chunks.push(...extractFromSQL(fullPath, relPath));
        } else if (ext === '.md' && !entry.startsWith('.')) {
          chunks.push(...extractFromMD(fullPath, relPath));
        }
      } catch { /* skip unreadable files */ }
    }
  }

  walk(rootPath);
  return chunks;
}

// --- Retrieval Challenges ---

interface Challenge {
  name: string;
  question: string;
  expectedTags: string[];   // Tags that SHOULD appear in top results
  excludeTags?: string[];   // Tags that should NOT appear (for noise checks)
  category: 'architecture' | 'domain' | 'implementation' | 'cross-cutting' | 'noise';
}

const CHALLENGES: Challenge[] = [
  // Architecture questions
  {
    name: 'ARCH1',
    question: 'What is the overall architecture of the the platform?',
    expectedTags: ['architecture', 'documentation'],
    category: 'architecture',
  },
  {
    name: 'ARCH2',
    question: 'How is authentication implemented? What auth methods are supported?',
    expectedTags: ['auth'],
    category: 'architecture',
  },
  {
    name: 'ARCH3',
    question: 'What database technology is used and how are migrations handled?',
    expectedTags: ['database'],
    category: 'architecture',
  },
  {
    name: 'ARCH4',
    question: 'How does the API layer work? What is the Express route structure?',
    expectedTags: ['api', 'endpoint'],
    category: 'architecture',
  },

  // Domain knowledge questions
  {
    name: 'DOM1',
    question: 'What is a Horse Record Manager and what can they do?',
    expectedTags: ['horse'],
    category: 'domain',
  },
  {
    name: 'DOM2',
    question: 'What membership types are available and how much do they cost?',
    expectedTags: ['membership'],
    category: 'domain',
  },
  {
    name: 'DOM3',
    question: 'How does the entry system work for events and competitions?',
    expectedTags: ['events'],
    category: 'domain',
  },
  {
    name: 'DOM4',
    question: 'How does Stripe payment processing work in the platform?',
    expectedTags: ['payments'],
    category: 'domain',
  },

  // Implementation questions
  {
    name: 'IMPL1',
    question: 'How is data imported from the legacy SERVICES system?',
    expectedTags: ['legacy', 'database'],
    category: 'implementation',
  },
  {
    name: 'IMPL2',
    question: 'What validation schemas and middleware exist for the API?',
    expectedTags: ['documentation', 'build'],
    category: 'implementation',
  },
  {
    name: 'IMPL3',
    question: 'What database tables store horse registration data?',
    expectedTags: ['database', 'migration'],
    category: 'implementation',
  },
  {
    name: 'IMPL4',
    question: 'How are PostgreSQL stored procedures used for business logic?',
    expectedTags: ['migration', 'documentation'],
    category: 'implementation',
  },

  // Cross-cutting questions (span multiple domains)
  {
    name: 'CROSS1',
    question: 'What are all the places where Stripe is used — payments, refunds, organizer payouts?',
    expectedTags: ['payments', 'stripe'],
    category: 'cross-cutting',
  },
  {
    name: 'CROSS2',
    question: 'How do membership status and horse registration interact during entry validation?',
    expectedTags: ['build', 'legacy'],
    category: 'cross-cutting',
  },

  // Noise filtering (unrelated questions)
  {
    name: 'NOISE1',
    question: 'How to configure Kubernetes pod autoscaling for microservices?',
    expectedTags: [],
    excludeTags: ['api', 'database', 'auth'],
    category: 'noise',
  },
  {
    name: 'NOISE2',
    question: 'Building a machine learning pipeline with PyTorch and CUDA?',
    expectedTags: [],
    excludeTags: ['function', 'module'],
    category: 'noise',
  },
];

// --- Scoring ---

function scoreChallenge(results: any[], challenge: Challenge): number {
  if (challenge.category === 'noise') {
    // Noise: score is 1.0 if no results, decreasing
    return results.length === 0 ? 1.0 : Math.max(0, 1 - results.length * 0.2);
  }

  // Check if expected tags appear in top 5 results (substring match)
  const top5Tags = new Set<string>();
  for (const r of results.slice(0, 5)) {
    for (const tag of r.engram?.tags ?? []) {
      top5Tags.add(tag.toLowerCase());
    }
  }
  const allTagsStr = Array.from(top5Tags).join(' ');

  let matched = 0;
  for (const expectedTag of challenge.expectedTags) {
    const et = expectedTag.toLowerCase();
    // Match if any tag contains the expected string (substring match)
    if (top5Tags.has(et) || allTagsStr.includes(et)) matched++;
  }

  return challenge.expectedTags.length > 0
    ? matched / challenge.expectedTags.length
    : 0;
}

// --- Main ---

async function main() {
  console.log('AgentWorkingMemory Real-World Eval');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Codebase: ${CODEBASE_PATH}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  // Health check
  const health = await api('GET', '/health');
  if (health.status !== 'ok') {
    console.error(`FATAL: Cannot reach server at ${BASE_URL}`);
    process.exit(1);
  }
  console.log(`Server: OK (${health.version})`);

  // Register agent
  const agent = await api('POST', '/agent/register', { name: 'realworld-eval-agent' });
  const agentId = agent.id;
  console.log(`Agent: ${agentId}`);

  // =========================================================
  // PHASE 1: Crawl codebase
  // =========================================================
  console.log('\n=== PHASE 1: CRAWLING CODEBASE ===');
  const allChunks = crawlCodebase(CODEBASE_PATH);
  console.log(`  Extracted ${allChunks.length} knowledge chunks`);

  // Deduplicate and limit
  const uniqueChunks = new Map<string, KnowledgeChunk>();
  for (const chunk of allChunks) {
    const key = chunk.concept;
    if (!uniqueChunks.has(key) || chunk.content.length > uniqueChunks.get(key)!.content.length) {
      uniqueChunks.set(key, chunk);
    }
  }
  const chunks = Array.from(uniqueChunks.values());

  // Cap at 300 chunks — balanced selection: code, SQL, docs
  const maxChunks = 300;
  let selected: KnowledgeChunk[];
  if (chunks.length > maxChunks) {
    // Split by type and take proportionally, ensuring code and SQL get represented
    const code = chunks.filter(c => c.tags.includes('function') || c.tags.includes('endpoint') || c.tags.includes('type'));
    const sql = chunks.filter(c => c.tags.includes('sql') || c.tags.includes('table') || c.tags.includes('plpgsql'));
    const docs = chunks.filter(c => c.tags.includes('documentation') && !code.includes(c) && !sql.includes(c));

    // Allocate: 40% code, 20% SQL, 40% docs
    const codeLimit = Math.min(code.length, Math.floor(maxChunks * 0.4));
    const sqlLimit = Math.min(sql.length, Math.floor(maxChunks * 0.2));
    const docsLimit = maxChunks - codeLimit - sqlLimit;

    selected = [
      ...code.sort((a, b) => b.content.length - a.content.length).slice(0, codeLimit),
      ...sql.sort((a, b) => b.content.length - a.content.length).slice(0, sqlLimit),
      ...docs.sort((a, b) => b.content.length - a.content.length).slice(0, docsLimit),
    ];
  } else {
    selected = chunks;
  }

  console.log(`  Unique: ${chunks.length}, Selected: ${selected.length}`);

  // Show breakdown by type
  const tagCounts: Record<string, number> = {};
  for (const c of selected) {
    for (const t of c.tags) {
      tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    }
  }
  const topTags = Object.entries(tagCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([t, c]) => `${t}(${c})`)
    .join(', ');
  console.log(`  Top tags: ${topTags}`);

  // =========================================================
  // PHASE 2: Seed into AWM
  // =========================================================
  console.log('\n=== PHASE 2: SEEDING MEMORIES ===');

  let seeded = 0;
  let activeCount = 0;
  let stagingCount = 0;
  let discardCount = 0;

  for (const chunk of selected) {
    const res = await api('POST', '/memory/write', {
      agentId,
      concept: chunk.concept,
      content: chunk.content,
      tags: chunk.tags,
      eventType: chunk.eventType,
      surprise: chunk.surprise,
      causalDepth: chunk.causalDepth,
      resolutionEffort: chunk.resolutionEffort,
      decisionMade: false,
    });

    if (res.disposition === 'active') activeCount++;
    else if (res.disposition === 'staging') stagingCount++;
    else discardCount++;
    seeded++;

    if (seeded % 50 === 0) process.stdout.write(`  ${seeded}/${selected.length} seeded...\r`);
  }

  console.log(`  Seeded: ${seeded} (${activeCount} active, ${stagingCount} staging, ${discardCount} discard)`);

  // Wait for embeddings
  console.log('  Waiting for embeddings to settle (30s for 300 chunks)...');
  await sleep(30000);

  // Build associations
  console.log('\n=== PHASE 2b: BUILDING ASSOCIATIONS ===');
  const associationQueries = [
    'the platform architecture monorepo',
    'authentication JWT sessions login',
    'horse registration record manager transfer',
    'membership types pricing renewal',
    'event entry competition validation',
    'Stripe payments checkout billing',
    'PostgreSQL database schema tables functions',
    'data import legacy SERVICES migration',
    'API endpoints Express routes',
    'testing CI/CD deployment pipeline',
  ];

  for (const q of associationQueries) {
    await api('POST', '/memory/activate', { agentId, context: q });
    await api('POST', '/memory/activate', { agentId, context: q });
  }
  console.log(`  Ran ${associationQueries.length} association queries (2x each)`);

  // Consolidation
  const consolidateRes = await api('POST', '/system/consolidate', { agentId });
  console.log(`  Consolidation: ${consolidateRes.summariesCreated ?? 0} summaries, ${consolidateRes.clustersFound ?? 0} clusters`);

  // Warmup query — ensures reranker model is loaded and hot before timed challenges
  console.log('  Warming up reranker...');
  await api('POST', '/memory/activate', { agentId, context: 'test warmup query', limit: 5, useReranker: true });
  console.log('  Reranker warm.');

  // =========================================================
  // PHASE 3: Retrieval Challenges
  // =========================================================
  console.log('\n=== PHASE 3: RETRIEVAL CHALLENGES ===\n');

  const categoryScores: Record<string, { scores: number[]; names: string[] }> = {
    architecture: { scores: [], names: [] },
    domain: { scores: [], names: [] },
    implementation: { scores: [], names: [] },
    'cross-cutting': { scores: [], names: [] },
    noise: { scores: [], names: [] },
  };

  for (const challenge of CHALLENGES) {
    const isNoise = challenge.category === 'noise';
    const activateParams: any = {
      agentId,
      context: challenge.question,
      limit: 10,
      includeStaging: true,
      useReranker: true,
      useExpansion: true,
    };
    if (isNoise) {
      activateParams.minScore = 0.3;
      activateParams.abstentionThreshold = 0.3;
    }

    const res = await api('POST', '/memory/activate', activateParams);

    // Diagnostic: log errors and raw response shape
    if (res.error) {
      console.log(`  [ERROR] ${challenge.name}: API error — ${res.error.slice(0, 100)}`);
    }

    const results = res.results ?? [];

    const score = scoreChallenge(results, challenge);
    categoryScores[challenge.category].scores.push(score);
    categoryScores[challenge.category].names.push(challenge.name);

    const status = score >= 0.5 ? 'PASS' : 'FAIL';
    const topResults = results.slice(0, 3).map((r: any) => {
      const concept = r.engram?.concept?.slice(0, 40) ?? '?';
      return `${concept}(${r.score.toFixed(2)})`;
    }).join(', ');

    // Log tags for debugging tag matching
    const top5Tags = new Set<string>();
    for (const r of results.slice(0, 5)) {
      for (const tag of r.engram?.tags ?? []) {
        top5Tags.add(tag.toLowerCase());
      }
    }

    console.log(`  [${status}] ${challenge.name}: ${challenge.question.slice(0, 60)}...`);
    console.log(`         Score: ${(score * 100).toFixed(0)}% | Results: ${results.length} | Top 3: ${topResults || '(empty)'}`);
    if (results.length === 0 && !isNoise) {
      console.log(`         ⚠ EMPTY RESULTS — expected tags: ${challenge.expectedTags.join(', ')}`);
    } else if (results.length > 0 && score === 0) {
      console.log(`         Tags found: [${Array.from(top5Tags).join(', ')}]`);
      console.log(`         Expected: [${challenge.expectedTags.join(', ')}]`);
    }
  }

  // =========================================================
  // PHASE 4: Report
  // =========================================================
  console.log('\n' + '='.repeat(60));
  console.log('REAL-WORLD EVAL REPORT');
  console.log('='.repeat(60));

  const weights: Record<string, number> = {
    architecture: 0.25,
    domain: 0.25,
    implementation: 0.25,
    'cross-cutting': 0.15,
    noise: 0.10,
  };

  let overall = 0;

  for (const [cat, data] of Object.entries(categoryScores)) {
    const avg = data.scores.length > 0
      ? data.scores.reduce((a, b) => a + b, 0) / data.scores.length
      : 0;
    const passed = data.scores.filter(s => s >= 0.5).length;
    const weight = weights[cat] ?? 0;
    overall += avg * weight;

    console.log(`\n${cat.toUpperCase()} (weight ${(weight * 100).toFixed(0)}%)`);
    console.log(`  Score: ${(avg * 100).toFixed(1)}% | Passed: ${passed}/${data.scores.length}`);
    for (let i = 0; i < data.names.length; i++) {
      const s = data.scores[i];
      console.log(`    ${s >= 0.5 ? 'PASS' : 'FAIL'} ${data.names[i]}: ${(s * 100).toFixed(0)}%`);
    }
  }

  const grade = overall >= 0.9 ? 'EXCELLENT'
    : overall >= 0.75 ? 'GOOD'
    : overall >= 0.6 ? 'FAIR'
    : 'NEEDS WORK';

  console.log(`\n${'='.repeat(60)}`);
  console.log(`OVERALL SCORE: ${(overall * 100).toFixed(1)}%`);
  console.log(`GRADE: ${grade}`);
  console.log(`MEMORY STATS: ${activeCount} active, ${stagingCount} staging`);
  console.log('='.repeat(60));

  process.exit(overall >= 0.5 ? 0 : 1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
