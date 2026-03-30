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
  /** Hook sidecar port */
  hookPort: string;
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

  /** Validate that the setup is healthy. */
  diagnose(ctx: SetupContext): DiagnosticResult[];
}
