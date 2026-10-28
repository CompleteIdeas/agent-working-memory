// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Labelled fixture for write-time redaction (S1). Every case says which rule SHOULD fire
 * (positives) or that NO rule should fire (negatives). tests/core/redact.test.ts turns it
 * into per-rule precision and recall, so a rule change that starts eating real content
 * fails CI instead of quietly destroying memories.
 *
 * The fake credentials are assembled from pieces at run time. Written out whole they would
 * trip GitHub's push protection and secret scanners on this very file. None is a real key.
 */

const j = (...parts: string[]) => parts.join('');
const rep = (s: string, n: number) => s.repeat(n);

export interface FixtureCase {
  text: string;
  /** Rule types expected to fire on `text`, in any order. Empty = a negative. */
  expect: string[];
  note?: string;
}

export const POSITIVES: FixtureCase[] = [
  { text: j('Use ', 'sk', '_live_', '51Hx9Tq2LmN8vB4kP7rS0dWz', ' for the payout test'), expect: ['stripe_key'] },
  { text: j('restricted key ', 'rk', '_test_', 'a1B2c3D4e5F6g7H8i9J0kLmN'), expect: ['stripe_key'] },
  { text: j('webhook signing secret is ', 'wh', 'sec_', '7fQk2Lm9Np4Rs8Tv1Wx5Yz3Ab6Cd'), expect: ['stripe_webhook_secret'] },
  { text: j('ANTHROPIC key: ', 'sk', '-ant-', 'api03-', 'Zx8Kq2Lm9Np4Rs8Tv1Wx5Yz3Ab6CdEf'), expect: ['anthropic_key'] },
  { text: j('openai ', 'sk', '-proj-', 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78'), expect: ['openai_key'] },
  { text: j('pushed with ', 'gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'), expect: ['github_token'] },
  { text: j('fine-grained ', 'github', '_pat_', '11ABCDEFG0', rep('aB3_', 14)), expect: ['github_token'] },
  { text: j('AWS id ', 'AKIA', 'IOSFODNN7EXAMPL3', ' in us-east-1'), expect: ['aws_access_key_id'] },
  { text: j('maps key ', 'AIza', 'SyD3k9Lm2Np8Qr4St7Uv1Wx5Yz0AbCdEfGh'), expect: ['google_api_key'] },
  { text: j('bot token ', 'xo', 'xb-', '1234567890-0987654321-AbCdEfGhIjKl'), expect: ['slack_token'] },
  { text: j('alerts go to https://hooks.slack.com/services/', 'T0123ABCD/B0456EFGH/', 'xYz123AbC456dEf789GhI0'), expect: ['slack_webhook'] },
  { text: j('Resend key ', 're', '_NwAK4xQ2', '_Lm9Np4Rs8Tv1Wx5Yz3'), expect: ['resend_key'], note: 'the shape that leaked into CLAUDE.md' },
  { text: j('publish with ', 'npm', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'), expect: ['npm_token'] },
  { text: j('session cookie ', 'eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJ', 'zdWIiOiIxMjM0In0', '.', 'SflKxwRJSMeKKF2QT4fwpMeJf36P'), expect: ['jwt'] },
  { text: j('DATABASE_URL=postgresql://postgres:', 'Tq8vX2mL9pRs', '@shuttle.proxy.rlwy.net:41234/railway'), expect: ['url_password'] },
  { text: j('redis://default:', 'Hk3nP9qW2xZ7', '@redis.railway.internal:6379'), expect: ['url_password'] },
  { text: j('curl -H "Authorization: Bearer ', 'a8F3kL9mN2pQ7rS4tV6wX1yZ0bC5dE', '"'), expect: ['bearer_token'] },
  { text: 'admin password: Hunter2Plus!9', expect: ['labelled_secret'] },
  { text: j('MEDICAL_ENCRYPTION_KEY=', '9f3a1c7e5b2d8f4a6c0e9b3d7f1a5c8e'), expect: ['labelled_secret'] },
  { text: j('{"client_secret": "', 'cs_9Lm2Np8Qr4St7Uv1', '"}'), expect: ['labelled_secret'] },
  { text: j('JWT_SIGNING_KEY: ', 'k7Hq2Lm9Np4Rs8Tv'), expect: ['labelled_secret'] },
  { text: j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB\n-----END ', 'RSA PRIVATE KEY-----'), expect: ['pem_private_key'] },
  { text: j('-----BEGIN ', 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END ', 'OPENSSH PRIVATE KEY-----'), expect: ['pem_private_key'] },
  { text: 'member SSN on the form: 219-09-9999', expect: ['us_ssn'] },
  { text: j('| Server | `smtp.example-relay.net:587` |\n| Password | `', 'mQ6_3sv79J3ZJrsbBZ3eXw', '` |'), expect: ['labelled_secret'],
    note: 'a markdown table: the shape the first live-store scan missed' },
  { text: j('card on file ', '4532015112830366'), expect: ['payment_card'] },
  { text: j('the admin password `', 'usea2', '026x', '` is in two files'), expect: ['labelled_secret'],
    note: 'backticked value with no separator, eight characters' },
  { text: j('card on file ', '4111 1111 1111 1111', ' exp 12/28'), expect: ['payment_card'] },
  { text: j('Amex ', '3714-496353-98431'), expect: ['payment_card'] },
  { text: 'host contact is jen.marshall@wellnessloudoun.org', expect: ['email'] },
  { text: 'call the office at (703) 555-0142 before 5', expect: ['phone'] },
  { text: j('both: ', 'sk', '_live_', '51Hx9Tq2LmN8vB4kP7rS0dWz', ' and password=Zq8Lm2Np4Rs!'), expect: ['stripe_key', 'labelled_secret'] },
];

/**
 * Hard negatives — text that resembles a credential, an id or contact data and must come
 * through untouched. Most are lifted from the shapes that actually appear in this store:
 * commit hashes, deployment ids, tenant UUIDs, env-var names, ticket numbers, prices.
 */
export const NEGATIVES: FixtureCase[] = [
  { text: 'Deployed 67a2870 as Railway deployment e257d8f2-b677-4118-85d5-59be3746f42d', expect: [] },
  { text: 'tenant f5d53e32-fccc-4654-9259-45abb3eb94e1 is the demo club', expect: [] },
  { text: 'The Stripe secret lives in $env:CIDEAS_STRIPE_SECRET_KEY, never in CLAUDE.md', expect: [] },
  { text: 'STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY} in docker-compose', expect: [] },
  { text: 'api_key: <your key here>', expect: [] },
  { text: 'password: reset it through the magic link', expect: [] },
  { text: 'secret: rotate monthly', expect: [] },
  { text: 'token: CIDEAS_HUNT_ADMIN_TOKEN', expect: [], note: 'an env-var name as the value' },
  { text: 'The Secret key field reads "Secret key (sk_live_…)" on the settings page', expect: [] },
  { text: 'set max_tokens: 4000 and temperature 0.2', expect: [] },
  { text: 'AWM_RERANK_POOL=max(limit*4,40) and AWM_TOPN_MULT=8', expect: [] },
  { text: 'git SHA 560542bd46239293aa6e04fdb2f9a010e465fb94 on backup/ux-reviews', expect: [] },
  { text: 'commit c4ae7ff..1d48eb2, 1527 tests green', expect: [] },
  { text: 'Freshdesk ticket #18330 and event 18969, USEF 341980', expect: [] },
  { text: 'recall p50 256 ms, 1,542/1,542 tests, $8,293.00 not in the bank', expect: [] },
  { text: 'Cloudflare account 43a57685180f3a792bda82145d6cab20', expect: [], note: 'an account id is not a credential' },
  { text: 'workshop on 2026-10-26 at 19:00, room 3-B', expect: [] },
  { text: 'unix ms 1793043901422 and version id 1793043901-4222', expect: [] },
  { text: 'postgresql://postgres:***@host:5432/db (masked in the docs)', expect: [] },
  { text: 'connection string postgres://${PGUSER}:${PGPASSWORD}@localhost/rowos', expect: [] },
  { text: 'Authorization: Bearer $RAILWAY_API_TOKEN', expect: [] },
  { text: 'a risk-assessment-for-the-board-2026-q4-final-version doc', expect: [] },
  { text: 'task-runner-config-loader-v2-experimental-branch', expect: [] },
  { text: 'send to noreply@anthropic.com or test@example.com', expect: [] },
  { text: 'The JWT has three parts: header.payload.signature', expect: [] },
  { text: 'docs/decision-gap-closure-2026-10-10.md section S1', expect: [] },
  { text: 'version 0.20.1, node 22.11.0, port 8401-8410', expect: [] },
  { text: 'phone mockup at 390px and 1440px widths', expect: [] },
  { text: 'IP 192.168.1.20 and port 5544', expect: [] },
  { text: 'invoice 4111-2026-0042 for October', expect: [], note: 'card-like prefix, fails Luhn and length' },
  { text: '[REDACTED:stripe_key …WdWz] was rotated on 22 Oct', expect: [], note: 'already masked text stays masked' },
  { text: 'Robert decided the phrase is "Context changes everything"', expect: [], note: 'names are not redacted' },
  { text: 'the bearer secret baked into the hook config is regenerated on setup', expect: [] },
  { text: 'passwordless magic-link login, no password field', expect: [] },
  { text: 'access_token expiry is 3600 seconds', expect: [] },
  // Found by the first scan of the live store (scripts/redact-scan.ts), 2026-10-28.
  { text: '32.2+3.20 = 35.400000000000006 is not 35.4', expect: [], note: 'a float artifact, not a card' },
  { text: 'queue 457-458 then 219 222 224 223 225 227 230 running', expect: [] },
  { text: 'Stripe test card 4242 4242 4242 4242, any future expiry, any CVC', expect: [], note: 'a public test number' },
  { text: "const token = authHeader?.replace('Bearer ', '')", expect: [] },
  { text: 'DATABASE_URL="postgresql://postgres:postgres@localhost:5544/rowos"', expect: [], note: 'user == password local default' },
  { text: 'build postgresql://PGUSER:PGPASSWORD@RAILWAY_TCP_PROXY_DOMAIN:5432/PGDATABASE', expect: [] },
  { text: '| Password | reset through the portal |', expect: [] },
  { text: '| Forgot password | Services\\ForgotPassword.aspx.cs |', expect: [] },
  { text: 'RAILWAY_API_TOKEN="<railway token>" railway up', expect: [] },
  { text: 'a key-rotation script for MEDICAL_ENCRYPTION_KEY: rotate-medical-encryption.ts', expect: [] },
  { text: 'start the API with RESEND_API_KEY= PORT=4100 npx tsx src/index.ts', expect: [] },
  { text: 'topic=auth-must-change-password', expect: [], note: 'a tag on its own' },
];
