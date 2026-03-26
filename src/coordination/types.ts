// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * TypeScript interfaces for coordination API responses.
 * These types support typed API clients consuming the coordination HTTP endpoints.
 */

// ─── Shared Primitives ─────────────────────────────────────────

export type AgentRole = 'worker' | 'orchestrator' | 'coordinator' | 'dev-lead';
export type AgentStatus = 'idle' | 'working' | 'dead';
export type AssignmentStatus = 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed' | 'blocked';
export type CommandType = 'BUILD_FREEZE' | 'PAUSE' | 'RESUME' | 'SHUTDOWN';
export type FindingSeverity = 'critical' | 'error' | 'warn' | 'info';
export type FindingStatus = 'open' | 'resolved';

// ─── Agent ─────────────────────────────────────────────────────

export interface CheckinResponse {
  agentId: string;
  action: 'registered' | 'heartbeat' | 'reconnected';
  status: string;
  workspace: string | null;
}

export interface AgentDetail {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  current_task: string | null;
  pid: number | null;
  capabilities: string | null;
  workspace: string | null;
  metadata: string | null;
  last_seen: string;
  started_at: string | null;
  seconds_since_seen: number;
}

export interface AgentResponse {
  agent: AgentDetail;
  assignment: AssignmentSummary | null;
  locks: LockEntry[];
}

// ─── Assignments ───────────────────────────────────────────────

export interface Assignment {
  id: string;
  agent_id: string | null;
  task: string;
  description: string | null;
  status: AssignmentStatus;
  priority: number;
  blocked_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  result: string | null;
  commit_sha: string | null;
  workspace: string | null;
  context: string | null;
}

export interface AssignmentSummary {
  id: string;
  task: string;
  status: AssignmentStatus;
  priority: number;
  created_at: string;
}

export interface AssignmentWithAgent extends Assignment {
  agent_name: string | null;
  is_blocked: 0 | 1;
}

export interface AssignCreateResponse {
  assignmentId: string;
  status: 'assigned' | 'pending';
}

export interface AssignmentsListResponse {
  assignments: AssignmentWithAgent[];
  total: number;
}

// ─── Next ──────────────────────────────────────────────────────

export interface CommandEntry {
  id: number;
  command: CommandType;
  reason: string | null;
  issued_by: string | null;
  issued_at: string;
  workspace: string | null;
}

export interface NextResponse {
  agentId: string;
  status: string;
  assignment: Assignment | null;
  commands: CommandEntry[];
}

// ─── Locks ─────────────────────────────────────────────────────

export interface LockEntry {
  file_path: string;
  locked_at: string;
  reason: string | null;
}

export interface LockWithAgent extends LockEntry {
  agent_id: string;
  agent_name: string;
}

export interface LocksResponse {
  locks: LockWithAgent[];
}

// ─── Commands ──────────────────────────────────────────────────

export interface CommandResponse {
  active: boolean;
  command?: CommandType;
  reason?: string | null;
  issued_at?: string;
  commands: CommandEntry[];
}

// ─── Workers ───────────────────────────────────────────────────

export interface WorkerEntry {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  currentTask: string | null;
  capabilities: string[];
  workspace: string | null;
  lastSeen: string;
  secondsSinceSeen: number;
  alive: boolean;
}

export interface WorkersResponse {
  count: number;
  idle: number;
  working: number;
  workers: WorkerEntry[];
}

// ─── Events ────────────────────────────────────────────────────

export interface EventEntry {
  id: number;
  agent_id: string | null;
  agent_name: string | null;
  event_type: string;
  detail: string | null;
  created_at: string;
}

export interface EventsResponse {
  events: EventEntry[];
  last_id: number;
}

// ─── Decisions ─────────────────────────────────────────────────

export interface DecisionEntry {
  id: number;
  author_id: string;
  author_name: string;
  assignment_id: string | null;
  tags: string | null;
  summary: string;
  created_at: string;
}

export interface DecisionsResponse {
  decisions: DecisionEntry[];
}

// ─── Findings ──────────────────────────────────────────────────

export interface FindingEntry {
  id: number;
  category: string;
  severity: FindingSeverity;
  file_path: string | null;
  line_number: number | null;
  description: string;
  suggestion: string | null;
  status: FindingStatus;
  created_at: string;
  agent_name: string;
}

export interface FindingSeverityCount {
  severity: FindingSeverity;
  count: number;
}

export interface FindingsResponse {
  findings: FindingEntry[];
  stats: FindingSeverityCount[];
}

// ─── Status ────────────────────────────────────────────────────

export interface StatusResponse {
  agents: Array<{
    id: string;
    name: string;
    role: AgentRole;
    status: AgentStatus;
    current_task: string | null;
    last_seen: string;
    seconds_since_seen: number;
  }>;
  assignments: Array<{
    id: string;
    task: string;
    description: string | null;
    status: AssignmentStatus;
    agent_id: string | null;
    agent_name: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
  }>;
  locks: LockWithAgent[];
  stats: {
    alive_agents: number;
    busy_agents: number;
    pending_tasks: number;
    active_tasks: number;
    active_locks: number;
    open_findings: number;
    urgent_findings: number;
  };
  recentFindings: Array<{
    id: number;
    category: string;
    severity: FindingSeverity;
    file_path: string | null;
    description: string;
    agent_name: string;
    created_at: string;
  }>;
}

// ─── Stats ─────────────────────────────────────────────────────

export interface StatsResponse {
  workers: {
    total: number;
    alive: number;
    idle: number;
    working: number;
  };
  tasks: {
    total_assigned: number;
    completed: number;
    failed: number;
    pending: number;
    avg_completion_seconds: number | null;
  };
  decisions: {
    total: number;
    last_hour: number;
  };
  uptime_seconds: number;
}

// ─── Stale ─────────────────────────────────────────────────────

export interface StaleAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  last_seen: string;
  seconds_since_seen: number;
}

export interface StaleResponse {
  stale: StaleAgent[];
  threshold_seconds: number;
  cleaned?: number;
}
