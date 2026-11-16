import { expect, it } from "vitest";
import { mergeEvents, turnView } from "./turn";

it("shows the latest activity or plan step only while the turn runs", () => {
  const plan = JSON.stringify({
    type: "progress.updated",
    progress: {
      summary: "Fixing tests",
      items: [
        { text: "Patch", status: "completed" },
        { text: "Run CI", status: "active" },
      ],
    },
  });
  expect(
    turnView([
      { sequence: 1, kind: "message", text: " I'll fix the tests.\n" },
      { sequence: 2, kind: "activity", text: "Running go test" },
      { sequence: 3, kind: "progress", text: plan },
    ]),
  ).toEqual({ messages: ["I'll fix the tests."], status: "Fixing tests: Run CI" });
  expect(
    turnView([
      { sequence: 1, kind: "activity", text: "Running go test" },
      { sequence: 2, kind: "message", text: "Tests pass now." },
    ]),
  ).toEqual({ messages: ["Tests pass now."] });
});

it("drops trailing messages its result repeats", () => {
  expect(
    turnView(
      [
        { sequence: 1, kind: "message", text: "I'll look." },
        { sequence: 2, kind: "message", text: "Part one." },
        { sequence: 3, kind: "message", text: "Part two." },
      ],
      "Part one.\nPart two.",
    ),
  ).toEqual({ messages: ["I'll look."] });
});

it("merges a turn's carried events with those read since, once each and in order", () => {
  const carried = [
    { sequence: 1, kind: "message", text: "I'll look." },
    { sequence: 4, kind: "activity", text: "Running go test" },
  ] as const;
  const read = [
    { sequence: 4, kind: "activity", text: "Running go test" },
    { sequence: 5, kind: "message", text: "Found it." },
    { sequence: 6, kind: "activity", text: "Editing main.go" },
  ] as const;
  const merged = mergeEvents(carried, read);
  expect(merged.map(({ sequence }) => sequence)).toEqual([1, 4, 5, 6]);
  expect(turnView(merged)).toEqual({
    messages: ["I'll look.", "Found it."],
    status: "Editing main.go",
  });
  expect(mergeEvents(carried, [])).toBe(carried);
});
