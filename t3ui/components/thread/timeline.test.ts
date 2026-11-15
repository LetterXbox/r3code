import { expect, test } from "nsh/test";
import { mergeTimeline } from "./timeline";

test("folds only an async answer with a matching answered question", () => {
  const messages = [{ id: "async-answer:req", role: "user" as const, body: "Choice", order: 2 }, { id: "async-answer:other", role: "user" as const, body: "Other", order: 3 }];
  const question = { id: "q", type: "user_input_request", title: "Question", detail: "", status: "completed", order: 1, item: { id: "q", type: "user_input_request", questionAnswer: { requestId: "req", answers: {}, attachmentsByQuestionId: {} } } } as never;
  expect(mergeTimeline(messages, [question]).map((entry) => entry.id)).toEqual(["activity:q", "message:async-answer:other"]);
  expect(mergeTimeline(messages, []).length).toBe(2);
});

test("queued messages appear in the timeline when their run starts", () => {
  const messages = [{ id: "queued", role: "user" as const, body: "Continue", order: 1000, inputIntent: "queued_turn", status: "pending" }];
  expect(mergeTimeline(messages, [], [{ status: "queued", userMessageId: "queued" }])).toEqual([]);
  expect(mergeTimeline(messages, [], [{ status: "running", userMessageId: "queued" }]).map((entry) => entry.id)).toEqual(["message:queued"]);
});

test("conversation messages and tool activity follow their original order", () => {
  const timeline = mergeTimeline(
    [
      { id: "one", role: "user", body: "Run the checks", order: 1000 },
      { id: "two", role: "assistant", body: "They passed", order: 3000 },
    ],
    [{ id: "tool", type: "command_execution", title: "Run checks", detail: "npm test", status: "completed", order: 2000 }],
  );
  expect(timeline.map((entry) => entry.id)).toEqual(["message:one", "activity:tool", "message:two"]);
});

test("turn ordinals take priority when timestamps collide or move backwards", () => {
  const timeline = mergeTimeline(
    [
      { id: "one", role: "user", body: "Start", order: 4000, ordinal: 1 },
      { id: "two", role: "assistant", body: "Done", order: 1000, ordinal: 3 },
    ],
    [{ id: "tool", type: "command_execution", title: "Command", detail: "pwd", status: "completed", order: 1000, ordinal: 2 }],
  );
  expect(timeline.map((entry) => entry.id)).toEqual(["message:one", "activity:tool", "message:two"]);
});

test("a message without its ordinal is inserted between numbered entries by creation time", () => {
  const timeline = mergeTimeline(
    [
      { id: "one", role: "user", body: "Start", order: 1000, ordinal: 1 },
      { id: "two", role: "assistant", body: "Done", order: 3000 },
    ],
    [{ id: "tool", type: "command_execution", title: "Command", detail: "pwd", status: "completed", order: 2000, ordinal: 2 }],
  );
  expect(timeline.map((entry) => entry.id)).toEqual(["message:one", "activity:tool", "message:two"]);
});

test("a message arriving before its turn item cannot reorder the existing conversation", () => {
  const messages = [
    { id: "start", role: "user" as const, body: "Start", order: 4000, ordinal: 1 },
    { id: "answer", role: "assistant" as const, body: "Answer", order: 1000, ordinal: 3 },
  ];
  const activity = [{ id: "tool", type: "command_execution", title: "Command", detail: "pwd", status: "completed", order: 2000, ordinal: 2 }];
  const before = mergeTimeline(messages, activity).map((entry) => entry.id);
  const during = mergeTimeline([...messages, { id: "stream", role: "assistant", body: "Next chunk", order: 5000 }], activity);
  expect(during.filter((entry) => entry.id !== "message:stream").map((entry) => entry.id)).toEqual(before);
  expect(during.at(-1)?.id).toBe("message:stream");
});
