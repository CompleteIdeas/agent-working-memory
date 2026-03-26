// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Typed internal event emitter for coordination.
 * Lightweight Node EventEmitter wrapper with typed events.
 * Used to decouple route handlers from side-effects (channel push, logging, etc).
 */

import { EventEmitter } from 'events';

// ─── Event Payloads ──────────────────────────────────────────────

export interface AssignmentCreatedEvent {
  assignmentId: string;
  agentId: string;
  task: string;
  workspace?: string;
}

export interface AssignmentUpdatedEvent {
  assignmentId: string;
  agentId: string | null;
  status: string;
  result?: string;
}

export interface AssignmentCompletedEvent {
  assignmentId: string;
  agentId: string | null;
  result: string | null;
}

export interface AgentCheckinEvent {
  agentId: string;
  name: string;
  role: string;
  workspace?: string;
}

export interface AgentCheckoutEvent {
  agentId: string;
  name: string;
}

export interface SessionStartedEvent {
  agentId: string;
  channelId: string;
}

export interface SessionClosedEvent {
  agentId: string;
  channelId: string;
}

// ─── Event Map ───────────────────────────────────────────────────

export interface CoordinationEvents {
  'assignment.created': [AssignmentCreatedEvent];
  'assignment.updated': [AssignmentUpdatedEvent];
  'assignment.completed': [AssignmentCompletedEvent];
  'agent.checkin': [AgentCheckinEvent];
  'agent.checkout': [AgentCheckoutEvent];
  'session.started': [SessionStartedEvent];
  'session.closed': [SessionClosedEvent];
}

// ─── Typed Event Bus ─────────────────────────────────────────────

export class CoordinationEventBus extends EventEmitter {
  emit<K extends keyof CoordinationEvents>(event: K, ...args: CoordinationEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof CoordinationEvents>(event: K, listener: (...args: CoordinationEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  once<K extends keyof CoordinationEvents>(event: K, listener: (...args: CoordinationEvents[K]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof CoordinationEvents>(event: K, listener: (...args: CoordinationEvents[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

/** Create a new coordination event bus. */
export function createEventBus(): CoordinationEventBus {
  return new CoordinationEventBus();
}
