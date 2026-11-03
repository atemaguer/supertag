import { describe, expect, it } from "vitest";
import { timestampLines } from "./src/log-timestamps.js";

describe("service log timestamps", () => {
  const capture = () => {
    const written: string[] = [];
    const stream = {
      write: ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as NodeJS.WriteStream["write"],
    };
    timestampLines(stream, () => new Date("2026-10-03T00:55:25.000Z"));
    return { stream, text: () => written.join("") };
  };

  it("prefixes each plain line with an ISO 8601 time, across chunk boundaries", () => {
    const { stream, text } = capture();
    stream.write("Worklet laptop-worklet disconnected; ");
    stream.write("reconnecting\nRemote Worklet connected\n\n");
    stream.write(Buffer.from("Control Plane dispatch failed\n"));
    expect(text()).toBe(
      [
        "2026-10-03T00:55:25.000Z Worklet laptop-worklet disconnected; reconnecting",
        "2026-10-03T00:55:25.000Z Remote Worklet connected",
        "",
        "2026-10-03T00:55:25.000Z Control Plane dispatch failed",
        "",
      ].join("\n"),
    );
  });

  it("keeps JSON lines, which carry their own time, valid JSON", () => {
    const { stream, text } = capture();
    stream.write('{"type":"supertag.audit","at":"2026-10-03T00:54:49.174Z"}\n');
    expect(JSON.parse(text())).toEqual({
      type: "supertag.audit",
      at: "2026-10-03T00:54:49.174Z",
    });
  });
});
