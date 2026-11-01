import type { PushSender, SendResult } from "../src/application/notify.ts";
import type { Push } from "../src/domain/push.ts";

export interface FakeSender extends PushSender {
  sent: { token: string; push: Push }[];
  answers: Map<string, SendResult | Error>;
}

export function fakeSender(): FakeSender {
  const sent: FakeSender["sent"] = [];
  const answers = new Map<string, SendResult | Error>();
  return {
    sent,
    answers,
    send: (token, push) => {
      const answer = answers.get(token) ?? "sent";
      if (answer instanceof Error) return Promise.reject(answer);
      sent.push({ token, push });
      return Promise.resolve(answer);
    },
  };
}
