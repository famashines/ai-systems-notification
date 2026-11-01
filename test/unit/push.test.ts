import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DeviceLocale, PushDataV1, PushKind } from "@famashines/ai-systems-contracts";
import { isStale, maxAgeMs, pushFor, pushOf, texts } from "../../src/domain/push.ts";
import { rows } from "../events.ts";

for (const row of rows) {
  test(`push table: ${row.name}`, () => {
    const taskId = randomUUID();
    const data = pushOf(row.event(taskId));
    assert.deepEqual(data, row.push(taskId));
    if (data !== undefined) assert.deepEqual(PushDataV1.parse(data), data);
  });
}

test("each locale has a short title and body for each kind, and the locales differ", () => {
  for (const locale of DeviceLocale.options) {
    for (const kind of PushKind.options) {
      const { title, body } = texts[locale][kind];
      assert.ok(title.length > 0 && title.length <= 40, `${locale} ${kind} title`);
      assert.ok(body.length > 0 && body.length <= 120, `${locale} ${kind} body`);
    }
  }
  for (const kind of PushKind.options) {
    assert.equal(new Set(DeviceLocale.options.map((locale) => texts[locale][kind].title)).size, 3);
  }
});

test("a push has the text of the device locale and the push data only", () => {
  const data: PushDataV1 = { kind: "approval_needed", taskId: randomUUID() };
  assert.deepEqual(pushFor(data, "de"), {
    title: "Freigabe nötig",
    body: "Eine Aufgabe wartet auf Ihre Freigabe.",
    data,
  });
  assert.equal(pushFor({ kind: "budget" }, "ur").title, "بجٹ انتباہ");
  assert.equal(pushFor({ kind: "completed", taskId: randomUUID() }, "en").title, "Task done");
});

test("an event older than the max age is stale", () => {
  const row = rows[0];
  assert.ok(row);
  const now = new Date("2026-11-02T12:00:00.000Z");
  const at = (ms: number) => row.event(randomUUID(), new Date(now.getTime() - ms).toISOString());
  assert.equal(isStale(at(maxAgeMs), now), false);
  assert.equal(isStale(at(maxAgeMs + 1), now), true);
});
