import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { receipt, workerHostFailure } from "./src/rust-harness/client.ts";

describe("receipt", () => {
  it("keeps retrying while the Worker Host is unavailable or slow", async () => {
    // More tries than the three the adapter used to allow; the Worker Host bounds the wait.
    const failures = [
      Code.DeadlineExceeded,
      Code.Unavailable,
      Code.DeadlineExceeded,
      Code.DeadlineExceeded,
      Code.Unavailable,
    ];
    let calls = 0;
    const value = await receipt(async () => {
      const code = failures[calls++];
      if (code !== undefined) throw new ConnectError("the operation timed out", code);
      return "settled";
    });
    expect(value).toBe("settled");
    expect(calls).toBe(failures.length + 1);
  });

  it("retries a try the Worker Host's server timed out, which tonic reports as canceled", async () => {
    let calls = 0;
    const value = await receipt(async () => {
      if (calls++ < 2) throw new ConnectError("Timeout expired", Code.Canceled);
      return "settled";
    });
    expect(value).toBe("settled");
    expect(calls).toBe(3);
  });

  it("does not repeat a call this adapter canceled", async () => {
    let calls = 0;
    await expect(
      receipt(async () => {
        calls++;
        throw new ConnectError("This operation was aborted", Code.Canceled);
      }),
    ).rejects.toThrow("This operation was aborted");
    expect(calls).toBe(1);
  });

  it("does not repeat a call the Worker Host refused", async () => {
    let calls = 0;
    await expect(
      receipt(async () => {
        calls++;
        throw new ConnectError("execution is not accepting events", Code.FailedPrecondition);
      }),
    ).rejects.toThrow("execution is not accepting events");
    expect(calls).toBe(1);
  });
});

describe("workerHostFailure", () => {
  it("names a failed Worker Host call and its status without terminal controls", () => {
    expect(
      workerHostFailure(
        new ConnectError("the operation\u001b[2J timed out", Code.DeadlineExceeded),
      ),
    ).toBe("Worker Host call failed: [deadline_exceeded] the operation [2J timed out");
  });

  it("says nothing about other errors, which may carry provider output or paths", () => {
    expect(workerHostFailure(new Error("EACCES: /home/operator/.cursor/token"))).toBeUndefined();
  });
});
