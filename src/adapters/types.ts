// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for CLI adapters.
 *
 * Each AI CLI tool (Claude Code, Codex, Cursor, etc.) gets its own adapter
 * that implements CLIAdapter. The setup orchestrator in cli.ts delegates to
 * the selected adapter.
 */

export interface SetupContext {
  /** Current working directory */
  cwd: string;
  /** Lowercase project name derived from cwd */
  projectName: string;
  /** Agent identifier for AWM */
  agentId: string;
  /** Absolute path to the SQLite database */
  dbPath: string;
  /** Absolute path to the AWM package root */
  packageRoot: string;
  /** Absolute path to dist/mcp.js (compiled entrypoint) */
  mcpDist: string;
  /** Absolute path to src/mcp.ts (dev entrypoint) */
  mcpScript: string;
  /** Whether dist/mcp.js exists (determines command strategy) */
  hasDist: boolean;
  /** Hook sidecar secret token */
  hookSecret: string;
  /** Hook sidecar port (preferred; the sidecar walks upward from here when busy) */
  hookPort: string;
  /** How many ports upward from hookPort the sidecar may try (0.14.2) */
  hookPortRange: string;
  /** Install the UserPromptSubmit prime hook (0.14.6; `--no-prime` turns it off) */
  installPrime: boolean;
  /** Whether to use global scope */
  isGlobal: boolean;
  /** Windows platform */
  isWindows: boolean;
  /** Pre-built environment variables for the MCP server */
  envVars: Record<string, string>;
}

export interface SetupResult {
  configAction: string;
  instructionsAction: string;
  hooksAction: string;
}

export interface DiagnosticResult {
  check: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

export interface CLIAdapter {
  /** Short identifier: 'claude-code', 'codex', 'cursor', 'http' */
  id: string;
  /** Display name for output */
  name: string;
  /** Does this adapter support project-level scope? */
  supportsProjectScope: boolean;
  /** Does this adapter support global scope? */
  supportsGlobalScope: boolean;

  /** Write the MCP server config for this CLI. Returns action summary. */
  writeMcpConfig(ctx: SetupContext): string;

  /** Write/append instruction content. Returns action summary. */
  writeInstructions(ctx: SetupContext, skip: boolean): string;

  /** Configure hooks (if supported). Returns action summary. */
  writeHooks(ctx: SetupContext, skip: boolean): string;

  /** Validate that the setup is healthy. May probe the network, hence possibly async. */
  diagnose(ctx: SetupContext): DiagnosticResult[] | Promise<DiagnosticResult[]>;

  /**
   * The env block of an AWM server entry this adapter previously wrote, if any.
   * `awm setup` re-runs preserve these values unless a flag overrides them, so an
   * upgrade never repoints the database or renames the agent (0.14.6).
   */
  readExistingEnv?(isGlobal: boolean, cwd: string): Record<string, string> | null;
}
