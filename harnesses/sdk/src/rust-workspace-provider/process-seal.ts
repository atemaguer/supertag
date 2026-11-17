/**
 * Sealing a sandbox before Capture: every process the Task could have started is stopped, so
 * nothing changes the tree while it is read, and nothing the Task left behind runs on.
 *
 * Right after allocation, the provider records the sandbox's own processes (each as a PID and
 * its start time, so a reused PID never counts). Sealing stops, then kills, every other process
 * except kernel threads, the seal program itself and its ancestors, repeating until a pass finds
 * none, and then confirms none is left. The record stays in the provider's memory, never in the
 * sandbox, where the Task could add itself to it.
 *
 * Both programs run as the sandbox's privileged user, so a Task process that gained more
 * privilege (E2B's `user` has sudo) is still stopped. Killing everything with `kill(-1)` is not
 * an option: on Modal it also kills PID 1, and the sandbox with it.
 */

/** Runs a trusted program as the sandbox's privileged user. */
export type PrivilegedRun = (
  argv: string[],
  timeoutMs: number,
  signal: AbortSignal,
) => Promise<{ readonly exitCode: number | null; readonly stdout: string }>;

const SEAL_TIMEOUT_MS = 30_000;
/** A sandbox holds a handful of its own processes; a larger record is not a sandbox. */
const MAX_RECORDED = 256;

const PROCESSES = `import json, os, sys
PF_KTHREAD = 0x00200000
def processes():
    found = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open("/proc/%s/stat" % name, "rb") as stat:
                raw = stat.read(4096)
        except OSError:
            continue
        fields = raw[raw.rindex(b")") + 2:].split()
        state, ppid, flags, start = fields[0], int(fields[1]), int(fields[6]), fields[19].decode()
        if flags & PF_KTHREAD or state in (b"Z", b"X"):
            continue
        found[int(name)] = (start, ppid)
    return found
def ancestors(table):
    chain, pid = set(), os.getpid()
    while pid > 0 and pid not in chain:
        chain.add(pid)
        pid = table.get(pid, (None, 0))[1]
    return chain
`;

const RECORD_PROGRAM = `${PROCESSES}
# Everything but this program: its (pid, start time) pairs never match a later process.
me = os.getpid()
print(json.dumps(sorted([pid, start] for pid, (start, _) in processes().items() if pid != me)))`;

const SEAL_PROGRAM = `${PROCESSES}
import signal, time
recorded = {(pid, start) for pid, start in json.loads(sys.argv[1])}
if not recorded or len(recorded) > ${MAX_RECORDED} or not any(pid == 1 for pid, _ in recorded):
    sys.exit(3)
def strangers():
    table = processes()
    keep = ancestors(table)
    return [pid for pid, (start, _) in table.items()
            if pid not in keep and (pid, start) not in recorded]
# Stop first, so nothing forks while the rest are found; then kill what was stopped.
stopped = set()
for _ in range(200):
    found = [pid for pid in strangers() if pid not in stopped]
    if not found:
        break
    for pid in found:
        try:
            os.kill(pid, signal.SIGSTOP)
        except OSError:
            pass
        stopped.add(pid)
for pid in stopped:
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
deadline = time.monotonic() + 10
while strangers():
    if time.monotonic() > deadline:
        sys.exit(4)
    for pid in strangers():
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    time.sleep(0.05)
print("sealed %d" % len(stopped))`;

function recordedProcesses(stdout: string): [number, string][] | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= MAX_RECORDED &&
      value.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          Number.isSafeInteger(entry[0]) &&
          entry[0] > 0 &&
          typeof entry[1] === "string" &&
          /^[0-9]{1,20}$/u.test(entry[1]),
      ) &&
      value.some((entry) => entry[0] === 1)
    )
      return value as [number, string][];
  } catch {
    /* refused below */
  }
  return undefined;
}

export interface ProcessSeal {
  /** Records the sandbox's own processes; call once, before the Task can start any. */
  record(signal: AbortSignal): Promise<void>;
  /** True only when every process outside the record is confirmed gone. */
  seal(signal: AbortSignal): Promise<boolean>;
}

export function createProcessSeal(run: PrivilegedRun): ProcessSeal {
  let recorded: [number, string][] | undefined;
  return {
    async record(signal) {
      if (recorded) throw new Error("Sandbox processes were already recorded");
      const result = await run(
        ["python3", "-I", "-S", "-c", RECORD_PROGRAM],
        SEAL_TIMEOUT_MS,
        signal,
      );
      const processes = result.exitCode === 0 ? recordedProcesses(result.stdout.trim()) : undefined;
      if (!processes) throw new Error("Sandbox processes could not be recorded");
      recorded = processes;
    },
    async seal(signal) {
      if (!recorded) return false;
      try {
        const result = await run(
          ["python3", "-I", "-S", "-c", SEAL_PROGRAM, JSON.stringify(recorded)],
          SEAL_TIMEOUT_MS,
          signal,
        );
        return result.exitCode === 0 && /^sealed [0-9]+$/u.test(result.stdout.trim());
      } catch {
        return false;
      }
    },
  };
}
