import { describe, it, expect, afterEach } from 'vitest';
import { redactText, redactFields, describeFindings } from '../../src/core/redact.js';
import { POSITIVES, NEGATIVES } from './redact-fixture.js';

const sorted = (xs: string[]) => [...xs].sort();

afterEach(() => {
  delete process.env.AWM_REDACT;
  delete process.env.AWM_REDACT_PII;
});

describe('redaction fixture — per-rule precision and recall', () => {
  it('fires exactly the expected rules on every labelled case', () => {
    const tp = new Map<string, number>();
    const fp = new Map<string, number>();
    const fn = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    const failures: string[] = [];

    for (const c of [...POSITIVES, ...NEGATIVES]) {
      const got = redactText(c.text).findings.map((f) => f.type);
      const want = [...c.expect];
      for (const g of got) {
        const i = want.indexOf(g);
        if (i >= 0) { bump(tp, g); want.splice(i, 1); } else { bump(fp, g); failures.push(`FP ${g}: ${c.text.slice(0, 70)}`); }
      }
      for (const w of want) { bump(fn, w); failures.push(`FN ${w}: ${c.text.slice(0, 70)}`); }
    }

    const rules = new Set([...tp.keys(), ...fp.keys(), ...fn.keys()]);
    const table = [...rules].sort().map((r) => {
      const t = tp.get(r) ?? 0, f = fp.get(r) ?? 0, n = fn.get(r) ?? 0;
      return `${r.padEnd(22)} tp ${t}  fp ${f}  fn ${n}`;
    });
    // Printed so a failing run shows the whole picture, not just the first mismatch.
    if (failures.length) console.log([...table, '', ...failures].join('\n'));
    expect(failures).toEqual([]);
  });

  it('covers every rule with at least one positive', () => {
    const covered = new Set(POSITIVES.flatMap((c) => c.expect));
    for (const rule of ['pem_private_key', 'anthropic_key', 'openai_key', 'stripe_key', 'stripe_webhook_secret',
      'github_token', 'aws_access_key_id', 'google_api_key', 'slack_token', 'slack_webhook', 'resend_key',
      'npm_token', 'jwt', 'url_password', 'bearer_token', 'labelled_secret', 'us_ssn', 'payment_card', 'email', 'phone']) {
      expect(covered, rule).toContain(rule);
    }
  });
});

describe('masking', () => {
  it('removes the credential and keeps the sentence', () => {
    const key = ['sk', '_live_', '51Hx9Tq2LmN8vB4kP7rS0dWz'].join('');
    const r = redactText(`Use ${key} for the payout test`);
    expect(r.text).not.toContain(key);
    expect(r.text).toBe('Use [REDACTED:stripe_key …0dWz] for the payout test');
  });

  it('masks only the value of a labelled secret, so the label stays findable', () => {
    const r = redactText('MEDICAL_ENCRYPTION_KEY=9f3a1c7e5b2d8f4a6c0e9b3d7f1a5c8e on rowos-app');
    expect(r.text).toBe('MEDICAL_ENCRYPTION_KEY=[REDACTED:labelled_secret] on rowos-app');
  });

  it('masks only the password inside a connection URL', () => {
    const r = redactText('postgresql://postgres:Tq8vX2mL9pRs@shuttle.proxy.rlwy.net:41234/railway');
    expect(r.text).toBe('postgresql://postgres:[REDACTED:url_password]@shuttle.proxy.rlwy.net:41234/railway');
  });

  it('is idempotent: redacting masked text changes nothing and reports nothing', () => {
    const once = redactText('admin password: Hunter2Plus!9').text;
    const twice = redactText(once);
    expect(twice.text).toBe(once);
    expect(twice.findings).toEqual([]);
  });

  it('reports email and phone without changing them by default', () => {
    const text = 'host contact jen.marshall@wellnessloudoun.org, (703) 555-0142';
    const r = redactText(text);
    expect(r.text).toBe(text);
    expect(sorted(r.findings.map((f) => `${f.type}:${f.masked}`))).toEqual(['email:false', 'phone:false']);
  });
});

describe('modes', () => {
  const key = ['sk', '_live_', '51Hx9Tq2LmN8vB4kP7rS0dWz'].join('');

  it('AWM_REDACT=report detects without changing the text', () => {
    process.env.AWM_REDACT = 'report';
    const r = redactText(`key ${key}`);
    expect(r.text).toBe(`key ${key}`);
    expect(r.findings).toEqual([{ type: 'stripe_key', tier: 'secret', masked: false }]);
  });

  it('AWM_REDACT=off does nothing', () => {
    process.env.AWM_REDACT = 'off';
    expect(redactText(`key ${key}`)).toEqual({ text: `key ${key}`, findings: [] });
  });

  it('AWM_REDACT_PII=mask masks email and phone', () => {
    process.env.AWM_REDACT_PII = 'mask';
    const r = redactText('mail jen.marshall@wellnessloudoun.org');
    expect(r.text).toBe('mail [REDACTED:email]');
  });
});

describe('redactFields and describeFindings', () => {
  it('redacts concept, content and tags together', () => {
    const { fields, findings } = redactFields(
      { concept: 'Stripe key', content: 'password=Zq8Lm2Np4Rs!', tags: ['topic=stripe', 'token=abc123def456ghi'] },
      ['concept', 'content', 'tags'],
    );
    expect(fields.content).toBe('password=[REDACTED:labelled_secret]');
    expect(fields.tags).toEqual(['topic=stripe', 'token=[REDACTED:labelled_secret]']);
    expect(findings.map((f) => f.type)).toEqual(['labelled_secret', 'labelled_secret']);
  });

  it('describes masked and reported findings for the write response', () => {
    expect(describeFindings([])).toBe('');
    const line = describeFindings([
      { type: 'stripe_key', tier: 'secret', masked: true },
      { type: 'stripe_key', tier: 'secret', masked: true },
      { type: 'email', tier: 'pii', masked: false },
    ]);
    expect(line).toContain('Redacted before storing: stripe_key ×2');
    expect(line).toContain('personal contact data (email)');
  });
});
