// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Zod validation schemas for the coordination module.
 * Ported from AgentSynapse packages/coordinator/src/schemas.ts.
 */

import { z } from 'zod';

// ─── Enums ──────────────────────────────────────────────────────

export const agentRoleEnum = z.enum(['worker', 'orchestrator', 'dev-lead']);
export const agentStatusEnum = z.enum(['idle', 'working', 'dead']);
export const assignmentStatusEnum = z.enum(['in_progress', 'completed', 'failed', 'blocked']);
export const commandEnum = z.enum(['BUILD_FREEZE', 'PAUSE', 'RESUME', 'SHUTDOWN']);
export const findingSeverityEnum = z.enum(['critical', 'error', 'warn', 'info']);
export const findingCategoryEnum = z.enum([
  'typecheck', 'lint', 'test-failure', 'security', 'performance',
  'dead-code', 'todo', 'bug', 'ux', 'a11y', 'sql', 'convention',
  'freshdesk', 'data-quality', 'other',
]);
export const findingStatusEnum = z.enum(['open', 'resolved']);

// ─── Checkin ────────────────────────────────────────────────────

export const checkinSchema = z.object({
  name: z.string().min(1).max(50),
  role: agentRoleEnum.default('worker'),
  pid: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  capabilities: z.array(z.string().max(50)).max(20).optional(),
  workspace: z.string().max(50).optional(),
});

export const checkoutSchema = z.object({
  agentId: z.string().uuid(),
});

// ─── Assignments ────────────────────────────────────────────────

export const assignCreateSchema = z.object({
  agentId: z.string().uuid().optional(),
  task: z.string().min(1).max(1000),
  description: z.string().max(5000).optional(),
  workspace: z.string().max(50).optional(),
  priority: z.number().int().min(0).max(10).default(0),
  blocked_by: z.string().uuid().optional(),
});

export const assignmentQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  name: z.string().min(1).max(50).optional(),
  workspace: z.string().max(50).optional(),
});

export const nextSchema = z.object({
  name: z.string().min(1).max(50),
  workspace: z.string().max(50).optional(),
  role: agentRoleEnum.default('worker'),
  capabilities: z.array(z.string().max(50)).max(20).optional(),
});

export const assignmentClaimSchema = z.object({
  agentId: z.string().uuid(),
});

export const assignmentUpdateSchema = z.object({
  status: assignmentStatusEnum,
  result: z.string().max(10000).optional(),
  commit_sha: z.string().max(100).optional(),
});

// ─── Locks ──────────────────────────────────────────────────────

export const lockAcquireSchema = z.object({
  agentId: z.string().uuid(),
  filePath: z.string().min(1).max(500),
  reason: z.string().max(500).optional(),
});

export const lockReleaseSchema = z.object({
  agentId: z.string().uuid(),
  filePath: z.string().min(1).max(500),
});

// ─── Commands ───────────────────────────────────────────────────

export const commandCreateSchema = z.object({
  command: commandEnum,
  reason: z.string().max(1000).optional(),
  issuedBy: z.string().max(50).optional(),
  workspace: z.string().max(50).optional(),
});

export const commandWaitQuerySchema = z.object({
  status: z.string().max(20).default('idle'),
  timeout: z.coerce.number().int().min(0).max(30).optional(),
  agentId: z.string().optional(),
  workspace: z.string().max(50).optional(),
});

// ─── Findings ───────────────────────────────────────────────────

export const findingCreateSchema = z.object({
  agentId: z.string().uuid(),
  category: findingCategoryEnum,
  severity: findingSeverityEnum.default('info'),
  filePath: z.string().max(500).optional(),
  lineNumber: z.number().int().positive().optional(),
  description: z.string().min(1).max(5000),
  suggestion: z.string().max(5000).optional(),
});

export const findingsQuerySchema = z.object({
  category: findingCategoryEnum.optional(),
  severity: findingSeverityEnum.optional(),
  status: findingStatusEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ─── Param Schemas ─────────────────────────────────────────────

export const assignmentIdParamSchema = z.object({ id: z.string().uuid() });
export const findingIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

// ─── Pulse ─────────────────────────────────────────────────────

export const pulseSchema = z.object({
  agentId: z.string().uuid(),
});

// ─── Decisions ─────────────────────────────────────────────────

export const decisionsQuerySchema = z.object({
  since_id: z.coerce.number().int().min(0).default(0),
  assignment_id: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

// ─── Status / Events ────────────────────────────────────────────

export const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const staleQuerySchema = z.object({
  seconds: z.coerce.number().int().min(1).max(86400).default(120),
  cleanup: z.enum(['0', '1', 'true', 'false']).optional(),
});

export const workersQuerySchema = z.object({
  capability: z.string().max(50).optional(),
  status: agentStatusEnum.optional(),
  workspace: z.string().max(50).optional(),
});
