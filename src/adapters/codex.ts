// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Codex CLI adapter — writes TOML config, AGENTS.md instructions.
 *
 * Codex stores MCP config in ~/.codex/config.toml (global only).
 * Uses snake_case [mcp_servers.name] sections.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { CLIAdapter, SetupContext, DiagnosticResult } from './types.js';
import { resolveMcpCommand, homedir, AWM_INSTRUCTION_CONTENT, upsertAwmSection } from './common.js';

// ─── Minimal TOML read/write ──────────────────────────
// Only handles the flat structure Codex uses: [section.name] with key = "value" or key = ["array"]

interface TomlSection {
  [key: string]: string | string[];
}

interface TomlDoc {
  /** Sections: key is the full dotted section name */
  sections: Map<string, TomlSection>;
  /** Lines before the first section (top-level keys, comments) */
  preamble: string[];
}

function parseTOML(content: string): TomlDoc {
  const doc: TomlDoc = { sections: new Map(), preamble: [] };
  let currentSection = '';
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Section header
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!doc.sections.has(currentSection)) {
        doc.sections.set(currentSection, {});
      }
      continue;
    }

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) {
      if (!currentSection) doc.preamble.push(line);
      continue;
    }

    // Key = value
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      if (!currentSection) doc.preamble.push(line);
      continue;
    }

    const key = trimmed.slice(0, eqIdx).trim();
    const rawVal = trimmed.slice(eqIdx + 1).trim();

    if (!currentSection) {
      if (!doc.sections.has('')) doc.sections.set('', {});
      doc.sections.get('')![key] = parseTomlValue(rawVal);
      continue;
    }

    if (!doc.sections.has(currentSection)) {
      doc.sections.set(currentSection, {});
    }
    doc.sections.get(currentSection)![key] = parseTomlValue(rawVal);
  }

  return doc;
}

function parseTomlValue(raw: string): string | string[] {
  // Array: ["a", "b"]
  if (raw.startsWith('[')) {
    const inner = raw.slice(1, raw.lastIndexOf(']'));
    return inner.split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, ''))
      .filter(s => s.length > 0);
  }
  // Quoted string
  return raw.replace(/^["']|["']$/g, '');
}

function serializeTOML(doc: TomlDoc): string {
  const lines: string[] = [];

  // Preamble (top-level content before any section)
  if (doc.preamble.length > 0) {
    lines.push(...doc.preamble);
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
      lines.push('');
    }
  }

  for (const [section, values] of doc.sections) {
    if (section === '') continue; // already in preamble
    lines.push(`[${section}]`);
    for (const [key, val] of Object.entries(values)) {
      if (Array.isArray(val)) {
        const items = val.map(v => `"${v}"`).join(', ');
        lines.push(`${key} = [${items}]`);
      } else {
        lines.push(`${key} = "${val}"`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Adapter ──────────────────────────────────────────

const adapter: CLIAdapter = {
  id: 'codex',
  name: 'Codex',
  supportsProjectScope: false,
  supportsGlobalScope: true,

  writeMcpConfig(ctx: SetupContext): string {
    if (!ctx.isGlobal) {
      console.log('  Note: Codex only supports global MCP config. Using --global automatically.');
    }

    const configPath = join(homedir(), '.codex', 'config.toml');
    const mcpCmd = resolveMcpCommand(ctx);

    // Read existing config or start fresh
    let doc: TomlDoc;
    if (existsSync(configPath)) {
      doc = parseTOML(readFileSync(configPath, 'utf-8'));
    } else {
      doc = { sections: new Map(), preamble: [] };
      mkdirSync(dirname(configPath), { recursive: true });
    }

    // Write the MCP server section
    const sectionName = 'mcp_servers.agent-working-memory';
    doc.sections.set(sectionName, {
      command: mcpCmd.command,
      args: mcpCmd.args,
    });

    // Write env vars in a sub-section
    const envSection = `${sectionName}.env`;
    const envEntries: TomlSection = {};
    for (const [key, val] of Object.entries(ctx.envVars)) {
      envEntries[key] = val;
    }
    doc.sections.set(envSection, envEntries);

    writeFileSync(configPath, serializeTOML(doc));
    return `MCP config: ${configPath}`;
  },

  writeInstructions(ctx: SetupContext, skip: boolean): string {
    const agentsMdPath = join(ctx.cwd, 'AGENTS.md');

    if (skip) return 'AGENTS.md: skipped (--no-instructions)';

    const title = `# ${basename(ctx.cwd)} — Agent Instructions`;
    return upsertAwmSection(agentsMdPath, AWM_INSTRUCTION_CONTENT, { titleIfNew: title });
  },

  writeHooks(_ctx: SetupContext, _skip: boolean): string {
    return 'Hooks: not supported by Codex (auto-checkpoint unavailable)';
  },

  diagnose(ctx: SetupContext): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];

    // Check TOML config
    const configPath = join(homedir(), '.codex', 'config.toml');
    if (!existsSync(configPath)) {
      results.push({
        check: 'MCP config',
        status: 'fail',
        message: `${configPath} not found`,
        fix: 'Run: awm setup codex',
      });
    } else {
      try {
        const doc = parseTOML(readFileSync(configPath, 'utf-8'));
        if (doc.sections.has('mcp_servers.agent-working-memory')) {
          results.push({ check: 'MCP config', status: 'ok', message: `AWM registered in ${configPath}` });

          // Verify the command points to a real file
          const section = doc.sections.get('mcp_servers.agent-working-memory')!;
          const args = section.args;
          if (Array.isArray(args) && args.length > 0) {
            const entrypoint = args[args.length - 1];
            if (existsSync(entrypoint)) {
              results.push({ check: 'MCP entrypoint', status: 'ok', message: entrypoint });
            } else {
              results.push({
                check: 'MCP entrypoint',
                status: 'fail',
                message: `Configured entrypoint not found: ${entrypoint}`,
                fix: 'Run: npm run build (in AWM package) then awm setup codex',
              });
            }
          }
        } else {
          results.push({
            check: 'MCP config',
            status: 'fail',
            message: 'config.toml exists but missing agent-working-memory section',
            fix: 'Run: awm setup codex',
          });
        }
      } catch {
        results.push({ check: 'MCP config', status: 'fail', message: `${configPath} could not be parsed` });
      }
    }

    // Check database
    if (existsSync(ctx.dbPath)) {
      results.push({ check: 'Database', status: 'ok', message: ctx.dbPath });
    } else {
      results.push({ check: 'Database', status: 'warn', message: `${ctx.dbPath} not found (will be created on first use)` });
    }

    // Check AGENTS.md
    const agentsMdPath = join(ctx.cwd, 'AGENTS.md');
    if (existsSync(agentsMdPath)) {
      const content = readFileSync(agentsMdPath, 'utf-8');
      if (content.includes('## Memory (AWM)')) {
        results.push({ check: 'Instructions', status: 'ok', message: 'AGENTS.md has AWM section' });
      } else {
        results.push({
          check: 'Instructions',
          status: 'warn',
          message: 'AGENTS.md exists but missing AWM section',
          fix: 'Run: awm setup codex',
        });
      }
    } else {
      results.push({ check: 'Instructions', status: 'warn', message: 'AGENTS.md not found' });
    }

    return results;
  },
};

export default adapter;
