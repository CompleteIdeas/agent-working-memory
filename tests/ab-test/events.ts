/**
 * Event Generator — creates a realistic stream of project events.
 *
 * Events simulate a developer working on a project over time:
 * - Important facts (architecture, business rules, key decisions)
 * - Bugs and issues discovered
 * - User preferences and conventions
 * - Noise (casual conversation, status updates, trivial observations)
 *
 * Each event has a ground-truth importance flag for scoring.
 */

import { createRng } from '../utils/seeded-random.js';

const rng = createRng();

export interface ProjectEvent {
  id: number;
  timestamp: string;
  category: 'fact' | 'decision' | 'bug' | 'preference' | 'noise';
  importance: 'high' | 'medium' | 'low';
  content: string;
  topic: string;        // topic tag for scoring
  quizzable: boolean;   // can we ask a question about this?
}

export interface QuizQuestion {
  id: number;
  question: string;
  answer: string;
  sourceEventId: number;
  topic: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

/**
 * Generate a realistic stream of project events.
 * Mix: ~25% important facts, ~15% decisions, ~10% bugs, ~10% preferences, ~40% noise
 */
export function generateEvents(count: number = 100): ProjectEvent[] {
  const events: ProjectEvent[] = [];
  let id = 0;
  const baseTime = Date.now();

  // Important facts — these should be remembered
  const facts: Omit<ProjectEvent, 'id' | 'timestamp'>[] = [
    { category: 'fact', importance: 'high', topic: 'database', content: 'The members table uses member_id (UUID) as primary key, not the legacy integer ID. All foreign keys reference this UUID.', quizzable: true },
    { category: 'fact', importance: 'high', topic: 'auth', content: 'Authentication uses JWT with RS256 signing. Access tokens expire after 15 minutes, refresh tokens after 7 days. Tokens are stored in httpOnly cookies, not localStorage.', quizzable: true },
    { category: 'fact', importance: 'high', topic: 'payments', content: 'Stripe Connect is used for organizer payouts. The platform takes a 2% fee on all transactions. The Stripe account ID is stored in the organizers table.', quizzable: true },
    { category: 'fact', importance: 'high', topic: 'horse', content: 'Every horse has exactly one Record Manager (RM). The RM is NOT the legal owner — the organization does not track legal ownership. Transfer costs $25 and requires multi-party approval.', quizzable: true },
    { category: 'fact', importance: 'high', topic: 'membership', content: 'Membership year runs December 1 through November 30. Full membership costs $120, Junior $95, Supporting $55, Life $1750. Partial year membership is $50.', quizzable: true },
    { category: 'fact', importance: 'high', topic: 'events', content: 'Entry validation checks: active membership, valid horse registration level, no outstanding balances, drug testing compliance, and SafeSport certification.', quizzable: true },
    { category: 'fact', importance: 'high', topic: 'architecture', content: 'The monorepo uses pnpm + Turborepo. Apps: web (Next.js 14), api (Express). Packages: shared (types/Zod), ui (components). Database is PostgreSQL on Azure.', quizzable: true },
    { category: 'fact', importance: 'high', topic: 'search', content: 'Meilisearch is used for full-text search across members, horses, and events. The search index is rebuilt nightly from PostgreSQL data.', quizzable: true },
    { category: 'fact', importance: 'medium', topic: 'database', content: 'PostgreSQL functions handle complex business logic: entry validation, standings calculation, health compliance checks. Simple CRUD uses inline parameterized queries.', quizzable: true },
    { category: 'fact', importance: 'medium', topic: 'areas', content: 'the organization has 10 geographic areas numbered I through X. Each area has its own awards program and area representative on the board.', quizzable: true },
    { category: 'fact', importance: 'medium', topic: 'horse', content: 'Horse registration types: Full $200 (Modified+), Limited $100 (BN/N/T), Restricted/TEST (free), FEH/YEH $25, Lifetime Foal $50. Registration type determines competition level.', quizzable: true },
    { category: 'fact', importance: 'medium', topic: 'api', content: 'All API responses follow the envelope pattern: { data, error, meta }. Errors include a machine-readable code and human-readable message.', quizzable: true },
  ];

  // Decisions
  const decisions: Omit<ProjectEvent, 'id' | 'timestamp'>[] = [
    { category: 'decision', importance: 'high', topic: 'auth', content: 'Decision: Password-based login is temporary for development. Production will use magic link + social login only. Passwords will be phased out before launch.', quizzable: true },
    { category: 'decision', importance: 'high', topic: 'deployment', content: 'Decision: CI/CD deploys are triggered by version tags only (v*), NOT by commits to main. This prevents accidental production deployments.', quizzable: true },
    { category: 'decision', importance: 'high', topic: 'database', content: 'Decision: Feature flags are stored in the platform_settings table, not environment variables. This allows runtime toggles without redeployment.', quizzable: true },
    { category: 'decision', importance: 'medium', topic: 'money', content: 'Decision: All monetary values stored as DECIMAL(10,2) in USD. Never use floating point for money. Frontend formats with Intl.NumberFormat.', quizzable: true },
    { category: 'decision', importance: 'medium', topic: 'validation', content: 'Decision: Zod is the sole validation library. Schemas are shared between frontend and backend via the packages/shared module. No duplicate validation.', quizzable: true },
  ];

  // Bugs
  const bugs: Omit<ProjectEvent, 'id' | 'timestamp'>[] = [
    { category: 'bug', importance: 'high', topic: 'payments', content: 'Bug: Stripe webhook handler has a race condition — if two webhooks arrive within 100ms for the same payment, it creates duplicate records. Need idempotency key check.', quizzable: true },
    { category: 'bug', importance: 'high', topic: 'auth', content: 'Bug: The refresh token rotation is broken — when a refresh token is used, the old one is not invalidated. This means stolen refresh tokens work forever.', quizzable: true },
    { category: 'bug', importance: 'medium', topic: 'search', content: 'Bug: Meilisearch index does not include horse nicknames, only registered names. Users searching by nickname get no results.', quizzable: true },
    { category: 'bug', importance: 'medium', topic: 'import', content: 'Bug: The legacy data import truncates horse names longer than 50 characters. The database column is VARCHAR(100) but the import script has a hardcoded 50-char limit.', quizzable: true },
  ];

  // Preferences
  const preferences: Omit<ProjectEvent, 'id' | 'timestamp'>[] = [
    { category: 'preference', importance: 'medium', topic: 'code-style', content: 'Preference: Always use conventional commits (feat:, fix:, refactor:). Never force-push to main. Feature branches from main.', quizzable: true },
    { category: 'preference', importance: 'medium', topic: 'testing', content: 'Preference: Run individual test files, not the full suite: npx vitest run src/path/to/test.test.ts. Always run npx tsc --noEmit after changes.', quizzable: true },
    { category: 'preference', importance: 'low', topic: 'code-style', content: 'Preference: Use TypeScript strict mode everywhere. Prefer explicit return types on exported functions.', quizzable: true },
  ];

  // Noise — should NOT be remembered as important
  const noise: Omit<ProjectEvent, 'id' | 'timestamp'>[] = [
    { category: 'noise', importance: 'low', topic: 'casual', content: 'Had a good lunch today. The new Thai place down the street is really good.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'casual', content: 'Weather is nice today, might go for a walk after work.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'status', content: 'Running npm install... waiting for dependencies to download.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'status', content: 'Build passed. No type errors.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'casual', content: 'Need to remember to buy milk on the way home.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'status', content: 'Committing changes to feature branch.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'casual', content: 'The office is cold today. Someone turned the AC too low.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'status', content: 'Pulled latest from main. No conflicts.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'casual', content: 'Coffee break. Will continue in 10 minutes.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'status', content: 'Linter is complaining about unused imports. Fixing...', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'casual', content: 'Meeting at 3pm about the Q3 roadmap. Need to prepare slides.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'status', content: 'Tests are passing locally. Pushing to CI.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'casual', content: 'Listened to a good podcast about TypeScript this morning.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'status', content: 'Server restarted. Hot reload working again.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'casual', content: 'Reminder: team standup tomorrow at 9am.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'status', content: 'Debugging the CSS issue. Flexbox alignment problem.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'casual', content: 'That new VS Code extension is pretty nice. Saves time with snippets.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'status', content: 'Waiting for PR review from the team lead.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'status', content: 'Docker container rebuilt. Image size looks good.', quizzable: false },
    { category: 'noise', importance: 'low', topic: 'casual', content: 'Friday afternoon — looking forward to the weekend.', quizzable: false },
  ];

  // Build the event list — interleave important and noise
  const important = [...facts, ...decisions, ...bugs, ...preferences];
  const allNoise = [...noise];

  // Shuffle and interleave: for every important event, add ~2 noise events
  let noiseIdx = 0;
  let importantIdx = 0;

  while (events.length < count) {
    // Add 1-3 noise events
    const noiseCount = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < noiseCount && events.length < count; i++) {
      const n = allNoise[noiseIdx % allNoise.length];
      events.push({
        ...n,
        id: id++,
        timestamp: new Date(baseTime + events.length * 36000).toISOString(), // ~36s apart for 1hr
      });
      noiseIdx++;
    }

    // Add 1 important event
    if (importantIdx < important.length && events.length < count) {
      const imp = important[importantIdx];
      events.push({
        ...imp,
        id: id++,
        timestamp: new Date(baseTime + events.length * 36000).toISOString(),
      });
      importantIdx++;
    }
  }

  return events;
}

/**
 * Generate quiz questions from the events.
 */
export function generateQuiz(events: ProjectEvent[]): QuizQuestion[] {
  const quizzable = events.filter(e => e.quizzable);
  const questions: QuizQuestion[] = [];

  const questionTemplates: Record<string, (e: ProjectEvent) => QuizQuestion | null> = {
    'database-pk': (e) => e.topic === 'database' && e.content.includes('primary key') ? {
      id: questions.length, question: 'What type of primary key does the members table use?',
      answer: 'UUID (member_id), not the legacy integer ID', sourceEventId: e.id, topic: e.topic, difficulty: 'easy',
    } : null,
    'auth-tokens': (e) => e.topic === 'auth' && e.content.includes('JWT') ? {
      id: questions.length, question: 'How long do access tokens last? Where are they stored?',
      answer: '15 minutes, stored in httpOnly cookies (not localStorage)', sourceEventId: e.id, topic: e.topic, difficulty: 'medium',
    } : null,
    'stripe-fee': (e) => e.topic === 'payments' && e.content.includes('2%') ? {
      id: questions.length, question: 'What percentage fee does the platform take on transactions?',
      answer: '2% via Stripe Connect', sourceEventId: e.id, topic: e.topic, difficulty: 'easy',
    } : null,
    'horse-rm': (e) => e.topic === 'horse' && e.content.includes('Record Manager') ? {
      id: questions.length, question: 'Is the Horse Record Manager the legal owner? How much does transfer cost?',
      answer: 'No, the organization does not track legal ownership. Transfer costs $25.', sourceEventId: e.id, topic: e.topic, difficulty: 'medium',
    } : null,
    'membership-year': (e) => e.topic === 'membership' && e.content.includes('December') ? {
      id: questions.length, question: 'When does the the organization membership year start and end? What does a full membership cost?',
      answer: 'December 1 through November 30. Full membership is $120.', sourceEventId: e.id, topic: e.topic, difficulty: 'easy',
    } : null,
    'entry-validation': (e) => e.topic === 'events' && e.content.includes('validation checks') ? {
      id: questions.length, question: 'What does the entry validation system check?',
      answer: 'Active membership, valid horse registration level, no outstanding balances, drug testing compliance, SafeSport certification', sourceEventId: e.id, topic: e.topic, difficulty: 'hard',
    } : null,
    'monorepo': (e) => e.topic === 'architecture' && e.content.includes('Turborepo') ? {
      id: questions.length, question: 'What tools are used for the monorepo? What is the frontend framework?',
      answer: 'pnpm + Turborepo. Frontend is Next.js 14.', sourceEventId: e.id, topic: e.topic, difficulty: 'easy',
    } : null,
    'search': (e) => e.topic === 'search' && e.content.includes('Meilisearch') ? {
      id: questions.length, question: 'What search technology is used? What entities are indexed?',
      answer: 'Meilisearch. Indexes members, horses, and events.', sourceEventId: e.id, topic: e.topic, difficulty: 'medium',
    } : null,
    'pg-functions': (e) => e.topic === 'database' && e.content.includes('PostgreSQL functions') ? {
      id: questions.length, question: 'What kind of business logic is handled by PostgreSQL functions vs inline queries?',
      answer: 'Complex logic (entry validation, standings, health compliance) in PG functions. Simple CRUD uses inline parameterized queries.', sourceEventId: e.id, topic: e.topic, difficulty: 'hard',
    } : null,
    'areas': (e) => e.topic === 'areas' ? {
      id: questions.length, question: 'How many the organization geographic areas are there?',
      answer: '10 areas, numbered I through X', sourceEventId: e.id, topic: e.topic, difficulty: 'easy',
    } : null,
    'horse-reg': (e) => e.topic === 'horse' && e.content.includes('registration types') ? {
      id: questions.length, question: 'How much does a Full horse registration cost? What level does it allow?',
      answer: '$200, allows Modified and above', sourceEventId: e.id, topic: e.topic, difficulty: 'medium',
    } : null,
    'api-envelope': (e) => e.topic === 'api' ? {
      id: questions.length, question: 'What is the API response format pattern?',
      answer: 'Envelope pattern: { data, error, meta }', sourceEventId: e.id, topic: e.topic, difficulty: 'easy',
    } : null,
    'password-decision': (e) => e.category === 'decision' && e.content.includes('Password') ? {
      id: questions.length, question: 'What is the plan for password-based login in production?',
      answer: 'Passwords are temporary for dev. Production will use magic link + social login only.', sourceEventId: e.id, topic: e.topic, difficulty: 'medium',
    } : null,
    'deploy-decision': (e) => e.category === 'decision' && e.content.includes('version tags') ? {
      id: questions.length, question: 'What triggers a production deployment?',
      answer: 'Version tags only (v*), not commits to main', sourceEventId: e.id, topic: e.topic, difficulty: 'easy',
    } : null,
    'feature-flags': (e) => e.category === 'decision' && e.content.includes('feature flags') ? {
      id: questions.length, question: 'Where are feature flags stored?',
      answer: 'In the platform_settings database table, not environment variables', sourceEventId: e.id, topic: e.topic, difficulty: 'medium',
    } : null,
    'money-format': (e) => e.topic === 'money' ? {
      id: questions.length, question: 'How should monetary values be stored in the database?',
      answer: 'DECIMAL(10,2) in USD. Never floating point.', sourceEventId: e.id, topic: e.topic, difficulty: 'easy',
    } : null,
    'zod-decision': (e) => e.topic === 'validation' ? {
      id: questions.length, question: 'What validation library is used? Where are schemas shared?',
      answer: 'Zod. Shared via packages/shared between frontend and backend.', sourceEventId: e.id, topic: e.topic, difficulty: 'medium',
    } : null,
    'webhook-bug': (e) => e.category === 'bug' && e.content.includes('webhook') ? {
      id: questions.length, question: 'What bug was found in the Stripe webhook handler?',
      answer: 'Race condition — duplicate records when two webhooks arrive within 100ms. Needs idempotency key.', sourceEventId: e.id, topic: e.topic, difficulty: 'hard',
    } : null,
    'refresh-bug': (e) => e.category === 'bug' && e.content.includes('refresh token') ? {
      id: questions.length, question: 'What is the security issue with refresh token rotation?',
      answer: 'Old refresh tokens are not invalidated when used, so stolen tokens work forever.', sourceEventId: e.id, topic: e.topic, difficulty: 'hard',
    } : null,
    'nickname-bug': (e) => e.category === 'bug' && e.content.includes('nickname') ? {
      id: questions.length, question: 'Why do horse nickname searches fail?',
      answer: 'Meilisearch index only includes registered names, not nicknames.', sourceEventId: e.id, topic: e.topic, difficulty: 'medium',
    } : null,
    'import-bug': (e) => e.category === 'bug' && e.content.includes('truncates') ? {
      id: questions.length, question: 'What is the horse name truncation bug in the import script?',
      answer: 'Import script hardcodes 50-char limit but DB column is VARCHAR(100).', sourceEventId: e.id, topic: e.topic, difficulty: 'medium',
    } : null,
    'commit-pref': (e) => e.category === 'preference' && e.content.includes('conventional commits') ? {
      id: questions.length, question: 'What commit message format should be used?',
      answer: 'Conventional commits: feat:, fix:, refactor:. Never force-push to main.', sourceEventId: e.id, topic: e.topic, difficulty: 'easy',
    } : null,
    'test-pref': (e) => e.category === 'preference' && e.content.includes('vitest') ? {
      id: questions.length, question: 'How should tests be run during development?',
      answer: 'Individual files: npx vitest run src/path/to/test.test.ts. Always run tsc --noEmit after changes.', sourceEventId: e.id, topic: e.topic, difficulty: 'easy',
    } : null,
  };

  // Generate questions for quizzable events
  const usedTemplates = new Set<string>();
  for (const event of quizzable) {
    for (const [key, template] of Object.entries(questionTemplates)) {
      if (usedTemplates.has(key)) continue;
      const q = template(event);
      if (q) {
        q.id = questions.length;
        questions.push(q);
        usedTemplates.add(key);
        break;
      }
    }
  }

  // Add noise-rejection questions
  questions.push({
    id: questions.length,
    question: 'What restaurant was mentioned for lunch?',
    answer: '__NOISE__', // Should not be recalled as important
    sourceEventId: -1,
    topic: 'noise',
    difficulty: 'easy',
  });
  questions.push({
    id: questions.length,
    question: 'What podcast was listened to?',
    answer: '__NOISE__',
    sourceEventId: -1,
    topic: 'noise',
    difficulty: 'easy',
  });

  return questions;
}
