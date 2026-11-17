/**
 * Sealing a sandbox before Capture: every process the Task could have started is stopped, so
 * nothing changes the tree while it is read.
 *
 * Right after allocation, the provider records the sandbox's own processes (each as a PID and
 * its start time, so a reused PID never counts) and the absolute path of the interpreter that
 * recorded them. Sealing stops, then kills, every other process except kernel threads, the seal
 * program itself and its ancestors, repeating until a pass finds none, and confirms none is
 * left; then, in the same process with no gap, it executes Capture. The record stays in the
 * provider's memory, never in the sandbox, where the Task could add itself to it. Every step
 * fails closed: `/proc` must be procfs, every process entry must be readable or gone, and PID 1
 * must still be the recorded one.
 *
 * **What this is, and is not.** Where the Task can become root in the sandbox (Modal runs every
 * process as root; E2B's `user` has sudo, and E2B runs every command through a login shell),
 * the Task can replace the interpreter, the shell's profile, or the dynamic loader before the
 * seal runs, so the seal cannot be a boundary against a hostile Task there. It is a reliability
 * property: an honest Task's leftovers (a dev server, a watcher) never race Capture. Nothing the
 * sandbox returns is trusted either way: the Worker Host validates the tree and checks its path
 * scope at delivery, and Stop ends the sandbox and every process in it.
 *
 * Killing everything with `kill(-1)` is not an option: on Modal it also kills PID 1, and the
 * sandbox with it.
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
/** Only the fixed PATH and LANG reach the programs: no variable of the provider's shell. */
const CLEAN = ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"];

const PROCESSES = `import ctypes, json, os, sys
PF_KTHREAD = 0x00200000
PROC_SUPER_MAGIC = 0x9FA0
def check(condition):
    if not condition:
        sys.exit(5)
def procfs():
    # A Task that is root could mount over /proc, or over one process's entry, to hide it.
    buffer = ctypes.create_string_buffer(512)
    libc = ctypes.CDLL(None, use_errno=True)
    check(libc.statfs(b"/proc", buffer) == 0)
    check(int.from_bytes(buffer.raw[:8], sys.byteorder, signed=True) == PROC_SUPER_MAGIC)
    check(os.readlink("/proc/self") == str(os.getpid()))
def processes():
    procfs()
    found = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open("/proc/%s/stat" % name, "rb") as stat:
                raw = stat.read(4096)
        except (FileNotFoundError, ProcessLookupError):
            # It exited between the listing and the read, unless its entry is still there and
            # something was mounted over it to hide it.
            if os.path.lexists("/proc/%s" % name):
                sys.exit(6)
            continue
        except OSError:
            sys.exit(6)  # unreadable, so possibly hidden: fail closed
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
table = processes()
check(1 in table)
print(json.dumps({"interpreter": os.path.realpath(sys.executable),
                  "processes": sorted([pid, start] for pid, (start, _) in table.items() if pid != me)}))`;

/** Seals, prints `sealed N`, then executes the rest of its arguments in this same process. */
const SEAL_PROGRAM = `${PROCESSES}
import signal, time
recorded = {(pid, start) for pid, start in json.loads(sys.argv[1])}
then = sys.argv[2:]
if not recorded or len(recorded) > ${MAX_RECORDED} or not any(pid == 1 for pid, _ in recorded):
    sys.exit(3)
init = [start for pid, start in recorded if pid == 1][0]
def strangers():
    table = processes()
    check(table.get(1, (None,))[0] == init)
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
sys.stdout.write("sealed %d\\n" % len(stopped))
sys.stdout.flush()
if then:
    os.execv(then[0], then)`;

interface Recorded {
  readonly interpreter: string;
  readonly processes: [number, string][];
}

function recordedProcesses(stdout: string): Recorded | undefined {
  try {
    const value = JSON.parse(stdout) as { interpreter?: unknown; processes?: unknown };
    const processes = value.processes;
    if (
      typeof value.interpreter === "string" &&
      /^\/[A-Za-z0-9._/+-]{1,255}$/u.test(value.interpreter) &&
      !value.interpreter.split("/").includes("..") &&
      Array.isArray(processes) &&
      processes.length > 0 &&
      processes.length <= MAX_RECORDED &&
      processes.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          Number.isSafeInteger(entry[0]) &&
          entry[0] > 0 &&
          typeof entry[1] === "string" &&
          /^[0-9]{1,20}$/u.test(entry[1]),
      ) &&
      processes.some((entry) => entry[0] === 1)
    )
      return { interpreter: value.interpreter, processes: processes as [number, string][] };
  } catch {
    /* refused below */
  }
  return undefined;
}

export interface ProcessSeal {
  /** Records the sandbox's own processes; call once, before the Task can start any. */
  record(signal: AbortSignal): Promise<void>;
  /**
   * Seals the sandbox, then runs a Python program with the recorded interpreter in the same
   * process, so nothing can start between the two. `then` is that program's arguments after
   * `-c`. `sealed` is false unless every process outside the record was confirmed gone, and
   * `stdout` is what the program printed after sealing.
   */
  sealThen(
    then: readonly string[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{
    readonly sealed: boolean;
    readonly exitCode: number | null;
    readonly stdout: string;
  }>;
}

export function createProcessSeal(run: PrivilegedRun): ProcessSeal {
  let recorded: Recorded | undefined;
  return {
    async record(signal) {
      if (recorded) throw new Error("Sandbox processes were already recorded");
      const result = await run(
        [...CLEAN, "python3", "-I", "-S", "-c", RECORD_PROGRAM],
        SEAL_TIMEOUT_MS,
        signal,
      );
      const value = result.exitCode === 0 ? recordedProcesses(result.stdout.trim()) : undefined;
      if (!value) throw new Error("Sandbox processes could not be recorded");
      recorded = value;
    },
    async sealThen(then, timeoutMs, signal) {
      if (!recorded) return { sealed: false, exitCode: null, stdout: "" };
      const { interpreter, processes } = recorded;
      try {
        const result = await run(
          [
            ...CLEAN,
            interpreter,
            "-I",
            "-S",
            "-c",
            SEAL_PROGRAM,
            JSON.stringify(processes),
            ...(then.length ? [interpreter, "-I", "-S", "-c", ...then] : []),
          ],
          Math.max(timeoutMs, SEAL_TIMEOUT_MS),
          signal,
        );
        const [first = "", ...rest] = result.stdout.split("\n");
        const sealed = /^sealed [0-9]+$/u.test(first) && (then.length > 0 || result.exitCode === 0);
        return { sealed, exitCode: result.exitCode, stdout: rest.join("\n") };
      } catch {
        return { sealed: false, exitCode: null, stdout: "" };
      }
    },
  };
}

/** The record and seal programs, for tests that run them in a real Linux PID namespace. */
export const PROCESS_SEAL_PROGRAMS = { record: RECORD_PROGRAM, seal: SEAL_PROGRAM } as const;
