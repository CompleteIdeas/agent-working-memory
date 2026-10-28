// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Write-time redaction (S1, docs/decision-gap-closure-2026-10-10.md).
 *
 * A memory store is read back into every later session, so a credential that lands in
 * one write is replayed into every transcript that recalls it — and, once S2 ships, into
 * every exported recall trace. Redaction therefore runs BEFORE anything is stored,
 * indexed or embedded.
 *
 * Two tiers, deliberately unequal:
 *
 *   secret — credentials with a recognizable shape (provider key prefixes, PEM private
 *            keys, JWTs, passwords in connection strings, `password=`/`api_key:` style
 *            assignments). Masked by default. A secret has no legitimate reason to be
 *            remembered verbatim: the memory that helps is "the Stripe key is in
 *            CIDEAS_STRIPE_SECRET_KEY", never the key. Masking is irreversible on
 *            purpose — keeping the original in a side column would leave the credential
 *            at rest, which is the exposure this exists to close.
 *
 *   pii    — government ids and payment cards are masked by default (high harm, no
 *            recall value). Email addresses and phone numbers are only REPORTED by
 *            default: in a personal or team memory store "the host contact is
 *            jen@…" is often the point of the memory. AWM_REDACT_PII=mask masks them too.
 *
 * Names are not detected. Telling a person's name from a product, place or project name
 * needs a model this layer does not have, and a name in "Robert decided X" is the memory.
 *
 * Every rule is tuned for precision over recall: a false positive destroys real content,
 * a false negative is the status quo. The labelled fixture in
 * tests/core/redact-fixture.ts measures both, per rule, and runs in CI.
 *
 * Environment:
 *   AWM_REDACT      mask (default) | report | off   — the secret tier and SSN/card
 *   AWM_REDACT_PII  report (default) | mask | off   — email and phone
 */

import { getVault, vaultIdsIn } from './vault.js';

export type RedactTier = 'secret' | 'pii';
export type RedactMode = 'mask' | 'report' | 'off';

export interface RedactFinding {
  /** Rule id, e.g. `stripe_key`, `pem_private_key`, `email`. */
  type: string;
  tier: RedactTier;
  /** True when the text was changed; false when the finding was only reported. */
  masked: boolean;
  /** Vault id when the value was sealed rather than destroyed (S1b). */
  sealed?: string;
}

export interface RedactOptions {
  /**
   * Seal masked values in the vault and leave a handle, instead of destroying them. Used
   * for memory text — what AWM KNOWS. Logs, recall queries and checkpoints only mask: a
   * token that appeared in a search is not something to remember.
   */
  seal?: boolean;
}

export interface RedactResult {
  text: string;
  findings: RedactFinding[];
}

interface Rule {
  type: string;
  tier: RedactTier;
  /** Which env switch governs it: 'secret' → AWM_REDACT, 'contact' → AWM_REDACT_PII. */
  switch: 'secret' | 'contact';
  pattern: RegExp;
  /**
   * Index of the capture group holding the sensitive value. 0 = the whole match. Rules
   * that recognise a secret by its label (`password=`) mask only the value, so the label
   * — which is what makes the memory findable — survives.
   */
  group?: number;
  /** Extra check on the captured value; return false to skip a match. */
  accept?: (value: string, match: RegExpExecArray) => boolean;
  /** Show the last four characters in the mask (cards, long keys). Default true. */
  keepLast4?: boolean;
}

// Values that are obviously not real secrets: placeholders, env-var references, ellipses.
const PLACEHOLDER = /^(?:x{3,}|\*{3,}|\.{3,}|…|<[^>]*>|\{\{.*\}\}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$env:[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%|process\.env\.[A-Za-z_][A-Za-z0-9_]*|changeme|redacted|your[_-]?\w*|example\w*|placeholder|null|none|undefined|true|false|n\/a)$/i;

function looksLikePlaceholder(v: string): boolean {
  return PLACEHOLDER.test(v) || v.includes('…') || v.includes('...') || /^\[(?:REDACTED|VAULT)/.test(v)
    // `<railway token>`, `<paste`: a template the writer meant to be filled in.
    || v.startsWith('<');
}

/**
 * Shapes a labelled value takes when it is not a secret, found by scanning the live store:
 * a file path or file name (`Services\Login.aspx.cs`, `rotate-medical-encryption.ts`), and
 * the NEXT assignment on a line whose value was left blank (`RESEND_API_KEY= PORT=4100`).
 */
function looksLikeNonValue(v: string): boolean {
  return v.includes('\\')
    || /\.(?:ts|js|mjs|cjs|tsx|jsx|cs|aspx|py|json|md|sql|ya?ml|env|txt|html|ps1|sh|cmd)$/i.test(v)
    || /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)
    // A type name closing a code construct: `token:string}`, `secret: Buffer)`.
    || /^[A-Za-z]+[}\])>;,.]+$/.test(v);
}

/**
 * A labelled value is credential-shaped: one token, 6+ chars, letters AND digits or symbols.
 * Six, not eight: the live store held a working admin password of eight characters written
 * as `password \`usea2026\``, and weak passwords are the ones most often pasted.
 */
function credentialShaped(v: string): boolean {
  if (v.length < 6 || /\s/.test(v)) return false;
  if (looksLikePlaceholder(v)) return false;
  const hasLetter = /[A-Za-z]/.test(v);
  const hasDigit = /\d/.test(v);
  const hasSymbol = /[^A-Za-z0-9]/.test(v);
  if (!hasLetter) return false;
  // A plain word or a snake/kebab identifier (an env var name, a config key) is not a secret.
  if (!hasDigit && /^[A-Za-z]+(?:[_.-][A-Za-z]+)*$/.test(v)) return false;
  return hasDigit || hasSymbol;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const RULES: Rule[] = [
  // --- secret tier: shapes that are credentials wherever they appear ---
  {
    type: 'pem_private_key', tier: 'secret', switch: 'secret', keepLast4: false,
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
  },
  { type: 'anthropic_key', tier: 'secret', switch: 'secret', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: 'openai_key', tier: 'secret', switch: 'secret', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g,
    accept: (v) => !v.startsWith('sk-ant-') && /\d/.test(v) },
  { type: 'stripe_key', tier: 'secret', switch: 'secret', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { type: 'stripe_webhook_secret', tier: 'secret', switch: 'secret', pattern: /\bwhsec_[A-Za-z0-9]{24,}/g },
  { type: 'github_token', tier: 'secret', switch: 'secret', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g },
  { type: 'aws_access_key_id', tier: 'secret', switch: 'secret', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'google_api_key', tier: 'secret', switch: 'secret', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'slack_token', tier: 'secret', switch: 'secret', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { type: 'slack_webhook', tier: 'secret', switch: 'secret', keepLast4: false,
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
  { type: 'resend_key', tier: 'secret', switch: 'secret', pattern: /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9_]{12,}/g,
    accept: (v) => /\d/.test(v) && /[A-Z]/.test(v) },
  { type: 'npm_token', tier: 'secret', switch: 'secret', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { type: 'jwt', tier: 'secret', switch: 'secret', keepLast4: false,
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g },
  // Password inside a connection URL: scheme://user:PASSWORD@host — mask the password only.
  { type: 'url_password', tier: 'secret', switch: 'secret', group: 2, keepLast4: false,
    pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/([^\s:/@]+):([^\s@/]{3,})@[^\s/]/gi,
    accept: (v, m) => !looksLikePlaceholder(v) && !/^\*+$/.test(v)
      // An env-var name standing in for the password (PGPASSWORD) is a template, not a secret.
      && !/^[A-Z][A-Z0-9_]*$/.test(v)
      // user == password is a throwaway local default (postgres:postgres), not a credential.
      && v !== m[1]
      // A plain lowercase word (`nobody:nothing@`) is a placeholder in a test URL, not a password.
      && !/^[a-z]+$/.test(v) },
  { type: 'bearer_token', tier: 'secret', switch: 'secret', group: 1,
    pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g,
    accept: (v) => /\d/.test(v) && /[A-Za-z]/.test(v) },
  // `password: X`, `API_KEY=X`, `"client_secret": "X"` — mask the value, keep the label.
  {
    type: 'labelled_secret', tier: 'secret', switch: 'secret', group: 1, keepLast4: false,
    pattern: /\b(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|passphrase|secret|secret[_-]?key|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|signing[_-]?key|encryption[_-]?key|token)\b["']?(?:\s*(?:=|:=|:|\|)\s*["'`]?|\s+`)([^\s"'`,;|]{6,})/gi,
    // A code expression (`token = authHeader?.replace(`) is not a value.
    accept: (v) => credentialShaped(v) && !looksLikeNonValue(v)
      && !/[()]/.test(v) && !/^[A-Za-z_$][\w$]*\??\.[A-Za-z_$]/.test(v),
  },

  // --- pii tier ---
  {
    type: 'us_ssn', tier: 'pii', switch: 'secret',
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  {
    type: 'payment_card', tier: 'pii', switch: 'secret',
    // Contiguous, or grouped 4-4-4-4 / Amex 4-6-5 with one consistent separator. Never
    // part of a decimal or a longer digit run.
    pattern: /(?<![\d.])(?:\d{13,19}|\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?:\1\d{1,3})?|\d{4}([ -])\d{6}\2\d{5})(?![\d.])/g,
    accept: (v) => {
      const d = v.replace(/[ -]/g, '');
      // Card networks' published TEST numbers (Stripe 4242…, 4000…) are public documentation.
      if (/^(?:4242424242424242|4000\d{12}|5555555555554444|378282246310005)$/.test(d)) return false;
      if (d.length < 13 || d.length > 19) return false;
      // Issuer prefixes: Visa, Mastercard, Amex, Discover. Bare digit runs (ids, phone
      // numbers, timestamps) without one are not cards.
      if (!/^(?:4|5[1-5]|2[2-7]|3[47]|6011|65)/.test(d)) return false;
      return luhn(d);
    },
  },
  {
    type: 'email', tier: 'pii', switch: 'contact', keepLast4: false,
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    // noreply / example / placeholder addresses carry no personal data.
    accept: (v) => !/^(?:no-?reply|donotreply|noreply\+[^@]*)@/i.test(v) && !/@(?:example\.(?:com|org|net)|anthropic\.com)$/i.test(v),
  },
  {
    type: 'phone', tier: 'pii', switch: 'contact',
    pattern: /(?:\+\d{1,3}[ .-]?)?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g,
  },
];

function modeFor(sw: Rule['switch']): RedactMode {
  const raw = (sw === 'secret' ? process.env.AWM_REDACT : process.env.AWM_REDACT_PII)?.trim().toLowerCase();
  if (raw === 'mask' || raw === 'report' || raw === 'off') return raw;
  return sw === 'secret' ? 'mask' : 'report';
}

function maskFor(rule: Rule, value: string): string {
  const keep = rule.keepLast4 !== false && value.length >= 16;
  return keep ? `[REDACTED:${rule.type} …${value.slice(-4)}]` : `[REDACTED:${rule.type}]`;
}

/**
 * Redact one string. Rules run in order and each sees the output of the one before, so a
 * value masked by a specific rule (a Stripe key) is not re-reported by a generic one
 * (`api_key=`): the mask text no longer looks like a credential.
 */
export function redactText(text: string, opts: RedactOptions = {}): RedactResult {
  const findings: RedactFinding[] = [];
  if (!text) return { text, findings };
  let out = text;
  const vault = opts.seal ? getVault() : null;

  for (const rule of RULES) {
    const mode = modeFor(rule.switch);
    if (mode === 'off') continue;
    // The `d` flag gives exact capture-group positions; searching for the value's text
    // instead found "postgres" inside "postgresql" and masked the scheme.
    if (!rule.pattern.hasIndices) rule.pattern = new RegExp(rule.pattern.source, `${rule.pattern.flags}d`);
    rule.pattern.lastIndex = 0;
    const pieces: string[] = [];
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(out)) !== null) {
      if (m[0].length === 0) { rule.pattern.lastIndex++; continue; }
      const g = rule.group ?? 0;
      const value = m[g];
      if (value === undefined) continue;
      if (rule.accept && !rule.accept(value, m)) continue;
      if (value.startsWith('[REDACTED') || value.startsWith('[VAULT')) continue;
      const masked = mode === 'mask';
      if (!masked) { findings.push({ type: rule.type, tier: rule.tier, masked }); continue; }
      // Locate the captured group inside the match so only the value is replaced.
      const valueStart = g === 0 ? m.index : m.indices![g]![0];
      let replacement = maskFor(rule, value);
      let sealed: string | undefined;
      if (vault) {
        try {
          // The words just before the value say what it is ("RAILWAY_API_TOKEN=", "Stripe
          // payout key:"), which is what `awm vault list` shows a human later.
          const label = out.slice(Math.max(0, valueStart - 80), valueStart).replace(/\s+/g, ' ').trim();
          replacement = vault.seal(value, rule.type, label);
          sealed = vaultIdsIn(replacement)[0];
        } catch (err) {
          // A vault failure must never store the value: fall back to the plain mask.
          process.stderr.write(`[awm] vault seal failed, masking instead: ${(err as Error).message}
`);
        }
      }
      findings.push({ type: rule.type, tier: rule.tier, masked, ...(sealed ? { sealed } : {}) });
      pieces.push(out.slice(cursor, valueStart), replacement);
      cursor = valueStart + value.length;
    }
    if (cursor > 0) {
      pieces.push(out.slice(cursor));
      out = pieces.join('');
    }
  }

  // Known secrets (S1b): a value already in the vault is replaced by its handle wherever it
  // turns up — with or without a label the shape rules can see. Runs for every surface,
  // sealed or masked, whenever a vault is open; a handle names a value, it does not contain it.
  const known = modeFor('secret') === 'mask' ? getVault() : null;
  if (known) {
    try {
      for (const k of known.knownSecrets()) {
        if (!out.includes(k.value)) continue;
        const n = out.split(k.value).length - 1;
        out = out.split(k.value).join(k.handle);
        for (let i = 0; i < n; i++) findings.push({ type: 'known_secret', tier: 'secret', masked: true, sealed: vaultIdsIn(k.handle)[0] });
      }
    } catch (err) {
      process.stderr.write(`[awm] vault lookup failed: ${(err as Error).message}\n`);
    }
  }
  return { text: out, findings };
}

/** Redact several strings, e.g. a memory's concept, content and tags, with one combined report. */
export function redactFields<T extends object>(
  fields: T,
  keys: Array<keyof T>,
  opts: RedactOptions = {},
): { fields: T; findings: RedactFinding[] } {
  const findings: RedactFinding[] = [];
  const outFields = { ...fields };
  for (const key of keys) {
    const v = fields[key];
    if (typeof v === 'string') {
      const r = redactText(v, opts);
      findings.push(...r.findings);
      (outFields as Record<string, unknown>)[key as string] = r.text;
    } else if (Array.isArray(v)) {
      (outFields as Record<string, unknown>)[key as string] = v.map((item) => {
        if (typeof item !== 'string') return item;
        const r = redactText(item, opts);
        findings.push(...r.findings);
        return r.text;
      });
    }
  }
  return { fields: outFields, findings };
}

/** One line for a write response, or '' when there is nothing to say. */
export function describeFindings(findings: RedactFinding[]): string {
  if (findings.length === 0) return '';
  const count = (list: RedactFinding[]) => {
    const by = new Map<string, number>();
    for (const f of list) by.set(f.type, (by.get(f.type) ?? 0) + 1);
    return [...by].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ');
  };
  const sealed = findings.filter((f) => f.sealed);
  const masked = findings.filter((f) => f.masked && !f.sealed);
  const reported = findings.filter((f) => !f.masked);
  const parts: string[] = [];
  if (sealed.length) {
    const ids = [...new Set(sealed.map((f) => f.sealed))].map((id) => `#${id}`).join(', ');
    parts.push(`🔐 Sealed in the vault: ${count(sealed)} (${ids}). The memory keeps a handle, so recall still knows it. `
      + `To use a value without showing it: \`awm vault run <id> --env NAME -- <command>\`.`);
  }
  if (masked.length) {
    parts.push(`🔒 Redacted before storing: ${count(masked)}. Store a pointer (where the value lives) instead of the value itself.`);
  }
  if (reported.length) {
    parts.push(`Contains personal contact data (${count(reported)}), stored as written.`);
  }
  return parts.join(' ');
}
