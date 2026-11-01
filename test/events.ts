import { randomUUID } from "node:crypto";
import {
  parseEvent,
  type PushDataV1,
  type RegisteredEvent,
} from "@famashines/ai-systems-contracts";

export const sentinel = "SECRET-7f3a";

export const envelope = (
  type: string,
  payload: Record<string, unknown>,
  occurredAt = new Date().toISOString(),
): RegisteredEvent =>
  parseEvent({
    eventId: randomUUID(),
    type,
    schemaVersion: 1,
    streamId: type.startsWith("budget.") ? "budget-month-2026-11" : `task-${randomUUID()}`,
    version: 3,
    occurredAt,
    correlationId: randomUUID(),
    causationId: randomUUID(),
    actor: { kind: "system", id: "orchestration" },
    payload,
  });

const plan = (taskId: string, awaitsApproval: boolean) => ({
  taskId,
  planVersion: 1,
  awaitsApproval,
  subtasks: [
    {
      subtaskId: randomUUID(),
      title: `Prompt title ${sentinel}`,
      instructions: `Output ${sentinel}`,
      agentId: randomUUID(),
      dependsOn: [],
      needsApproval: true,
    },
  ],
});

export interface Row {
  name: string;
  event: (taskId: string, occurredAt?: string) => RegisteredEvent;
  push: (taskId: string) => PushDataV1 | undefined;
}

const blocked = (code: string) => (taskId: string, occurredAt?: string) =>
  envelope(
    "orchestration.RunBlocked",
    { taskId, runId: randomUUID(), code, reason: `Blocked ${sentinel}` },
    occurredAt,
  );

export const rows: Row[] = [
  {
    name: "RunCompleted gives completed",
    event: (taskId, occurredAt) =>
      envelope(
        "orchestration.RunCompleted",
        { taskId, runId: randomUUID(), summary: `The output ${sentinel}`, costMicroUsd: 12 },
        occurredAt,
      ),
    push: (taskId) => ({ kind: "completed", taskId }),
  },
  {
    name: "RunFailed gives failed",
    event: (taskId, occurredAt) =>
      envelope(
        "orchestration.RunFailed",
        { taskId, runId: randomUUID(), code: "subtask_failed", reason: `Failed ${sentinel}` },
        occurredAt,
      ),
    push: (taskId) => ({ kind: "failed", taskId }),
  },
  {
    name: "RunBlocked subtask_failed gives failed",
    event: blocked("subtask_failed"),
    push: (taskId) => ({ kind: "failed", taskId }),
  },
  {
    name: "RunBlocked forbidden gives failed",
    event: blocked("forbidden"),
    push: (taskId) => ({ kind: "failed", taskId }),
  },
  {
    name: "PlanProposed with awaitsApproval gives approval_needed",
    event: (taskId, occurredAt) =>
      envelope("orchestration.PlanProposed", plan(taskId, true), occurredAt),
    push: (taskId) => ({ kind: "approval_needed", taskId }),
  },
  {
    name: "CheckpointOpened gives approval_needed",
    event: (taskId, occurredAt) =>
      envelope(
        "orchestration.CheckpointOpened",
        {
          taskId,
          runId: randomUUID(),
          subtaskId: randomUUID(),
          checkpointId: randomUUID(),
          reason: `Approval needed for ${sentinel}`,
        },
        occurredAt,
      ),
    push: (taskId) => ({ kind: "approval_needed", taskId }),
  },
  {
    name: "ThresholdCrossed gives budget",
    event: (_taskId, occurredAt) =>
      envelope(
        "budget.ThresholdCrossed",
        {
          scope: { kind: "month", key: "2026-11" },
          cap: "hard",
          percent: 80,
          spentMicroUsd: 8,
          capMicroUsd: 10,
        },
        occurredAt,
      ),
    push: () => ({ kind: "budget" }),
  },
  {
    name: "RunBlocked budget_refused gives budget",
    event: blocked("budget_refused"),
    push: () => ({ kind: "budget" }),
  },
  {
    name: "RunBlocked runaway_stopped gives budget",
    event: blocked("runaway_stopped"),
    push: () => ({ kind: "budget" }),
  },
  {
    name: "PlanProposed in auto mode gives no push",
    event: (taskId, occurredAt) =>
      envelope("orchestration.PlanProposed", plan(taskId, false), occurredAt),
    push: () => undefined,
  },
  {
    name: "RunStarted gives no push",
    event: (taskId, occurredAt) =>
      envelope("orchestration.RunStarted", { taskId, runId: randomUUID() }, occurredAt),
    push: () => undefined,
  },
];
