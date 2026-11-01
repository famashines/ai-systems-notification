import type {
  DeviceLocale,
  PushDataV1,
  PushKind,
  RegisteredEvent,
} from "@famashines/ai-systems-contracts";

export interface Push {
  title: string;
  body: string;
  data: PushDataV1;
}

export const maxAgeMs = 24 * 60 * 60 * 1000;

export function pushOf(event: RegisteredEvent): PushDataV1 | undefined {
  switch (event.type) {
    case "orchestration.RunCompleted":
      return { kind: "completed", taskId: event.payload.taskId };
    case "orchestration.RunFailed":
      return { kind: "failed", taskId: event.payload.taskId };
    case "orchestration.RunBlocked":
      return event.payload.code === "budget_refused" || event.payload.code === "runaway_stopped"
        ? { kind: "budget" }
        : { kind: "failed", taskId: event.payload.taskId };
    case "orchestration.PlanProposed":
      return event.payload.awaitsApproval
        ? { kind: "approval_needed", taskId: event.payload.taskId }
        : undefined;
    case "orchestration.CheckpointOpened":
      return { kind: "approval_needed", taskId: event.payload.taskId };
    case "budget.ThresholdCrossed":
      return { kind: "budget" };
    default:
      return undefined;
  }
}

export const isStale = (event: RegisteredEvent, now: Date): boolean =>
  now.getTime() - Date.parse(event.occurredAt) > maxAgeMs;

export const texts: Readonly<
  Record<DeviceLocale, Readonly<Record<PushKind, { title: string; body: string }>>>
> = {
  en: {
    completed: { title: "Task done", body: "Your task has a result. Open the app to read it." },
    failed: { title: "Task failed", body: "Your task stopped. Open the app to see the reason." },
    approval_needed: { title: "Approval needed", body: "A task waits for your approval." },
    budget: {
      title: "Budget alert",
      body: "A budget limit or a spend rule needs your attention.",
    },
  },
  de: {
    completed: {
      title: "Aufgabe erledigt",
      body: "Ihre Aufgabe hat ein Ergebnis. Öffnen Sie die App, um es zu lesen.",
    },
    failed: {
      title: "Aufgabe fehlgeschlagen",
      body: "Ihre Aufgabe wurde gestoppt. Öffnen Sie die App, um den Grund zu sehen.",
    },
    approval_needed: {
      title: "Freigabe nötig",
      body: "Eine Aufgabe wartet auf Ihre Freigabe.",
    },
    budget: {
      title: "Budget-Hinweis",
      body: "Ein Budgetlimit oder eine Ausgabenregel braucht Ihre Aufmerksamkeit.",
    },
  },
  ur: {
    completed: {
      title: "کام مکمل",
      body: "آپ کے کام کا نتیجہ تیار ہے۔ اسے پڑھنے کے لیے ایپ کھولیں۔",
    },
    failed: { title: "کام ناکام", body: "آپ کا کام رک گیا۔ وجہ دیکھنے کے لیے ایپ کھولیں۔" },
    approval_needed: {
      title: "منظوری درکار",
      body: "ایک کام آپ کی منظوری کا انتظار کر رہا ہے۔",
    },
    budget: {
      title: "بجٹ انتباہ",
      body: "بجٹ کی حد یا اخراجات کا کوئی اصول آپ کی توجہ چاہتا ہے۔",
    },
  },
};

export const pushFor = (data: PushDataV1, locale: DeviceLocale): Push => ({
  ...texts[locale][data.kind],
  data,
});
