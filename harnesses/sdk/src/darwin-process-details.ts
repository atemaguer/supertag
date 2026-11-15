import { execFile } from "node:child_process";
import { constants } from "node:os";
import { promisify } from "node:util";

/**
 * macOS ships /usr/bin/perl on both supported architectures. Its syscall bridge avoids
 * requiring Xcode, Python, an FFI addon, or a runtime-compiled executable. Darwin syscall
 * numbers (getsid=310, sysctl=202), KERN_ARGMAX=8, and KERN_PROCARGS2=49 are shared by arm64
 * and x86_64. Only numeric session IDs, marker matches, and errno values leave the helper,
 * never argv or environment.
 *
 * The helper never dies on a per-process errno. It reports each PID as `gone` (ESRCH),
 * `denied` (EPERM/EACCES), a session with its marker match, or `error OP ERRNO` for a read
 * the kernel refused for another reason. The caller treats any `error` line as a failed
 * read of the whole batch, so a PID is only ever reported gone when getsid(2) said so.
 */
const DETAILS = String.raw`
use strict;
use warnings;
use Errno qw(ESRCH EPERM EACCES EINVAL EIO ENOMEM EAGAIN);
# kern.argmax bounds the argument area KERN_PROCARGS2 copies out, so one reused buffer of
# exactly that size holds every process's arguments. The kernel rejects a larger buffer with
# EINVAL and silently truncates to a smaller one.
my $argmax = do {
  my $mib = pack('i2', 1, 8);
  my $value = pack('i', 0);
  my $size = pack('J', length($value));
  syscall(202, $mib, 2, $value, $size, 0, 0) == 0
    or die 'kern.argmax failed errno=' . ($! + 0) . "\n";
  my $read = unpack('i', $value);
  "$read" =~ /\A([1-9][0-9]{0,8})\z/ or die "kern.argmax out of range\n";
  int($1);
};
my $buffer = "\0" x $argmax;
# Returns 1 or 0, or "procargs ERRNO" when the kernel refused the read for a reason that
# does not mean the process is unreadable to this user.
sub carries_marker {
  my ($pid, $needle) = @_;
  my $mib = pack('i3', 1, 49, $pid);
  my $args;
  for my $try (1 .. 3) {
    my $size = pack('J', length($buffer));
    if (syscall(202, $mib, 3, $buffer, $size, 0, 0) == 0) {
      $args = substr($buffer, 0, unpack('J', $size));
      last;
    }
    my $errno = $! + 0;
    # Apple protected binaries and other users' processes hide their environment (EINVAL,
    # EPERM, EACCES). EINVAL also occurs for exiting processes without an argument area.
    return 0 if $errno == ESRCH || $errno == EPERM || $errno == EACCES || $errno == EINVAL;
    # EIO: the argument pages could not be copied, as while the process execs or exits; it
    # cleared within 10 ms in every case observed. ENOMEM/EAGAIN: the kernel could not
    # allocate a copy buffer under memory pressure.
    return "procargs $errno" unless ($errno == EIO || $errno == ENOMEM || $errno == EAGAIN) && $try < 3;
    select(undef, undef, undef, $try == 1 ? 0.01 : 0.05);
  }
  return 0 if length($args) < 4;
  my $argc = unpack('i', substr($args, 0, 4));
  my $pos = index($args, "\0", 4);
  return 0 unless $argc > 0 && $argc <= length($args) && $pos >= 4;
  # Skip executable path and kernel padding, then exactly argc NUL-terminated args.
  $pos++ while $pos < length($args) && substr($args, $pos, 1) eq "\0";
  for (1 .. $argc) {
    my $end = index($args, "\0", $pos);
    return 0 if $end < $pos;
    $pos = $end + 1;
  }
  # Whitespace inside an argument or environment value never splits an entry.
  for my $variable (split(/\0/, substr($args, $pos))) {
    return 1 if $variable eq $needle;
  }
  return 0;
}
# Prints the outcome of a failed getsid(2) and returns.
sub getsid_failed {
  my ($pid) = @_;
  my $errno = $! + 0;
  if ($errno == ESRCH) { print "$pid gone\n"; return; }
  if ($errno == EPERM || $errno == EACCES) { print "$pid denied\n"; return; }
  print "$pid error getsid $errno\n";
}
my $needle = shift @ARGV;
for my $item (@ARGV) {
  $item =~ /\A([1-9][0-9]*):([01])\z/ or die "invalid process request\n";
  my ($pid, $inspect) = (int($1), int($2));
  my $sid = syscall(310, $pid);
  if ($sid < 0) { getsid_failed($pid); next; }
  my $marked = $inspect && length($needle) ? carries_marker($pid, $needle) : 0;
  my $again = syscall(310, $pid);
  if ($again < 0) { getsid_failed($pid); next; }
  if ($marked ne '0' && $marked ne '1') { print "$pid error $marked\n"; next; }
  next if $sid != $again;
  print "$pid $sid $marked\n";
}
`;

export interface DarwinProcessDetails {
  session: number;
  marked: boolean;
}

/** Runs the helper; rejects with an `execFile`-shaped error on failure. */
export type DarwinHelperRunner = (
  file: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
  },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export interface DarwinProcessDetailsOptions {
  /** Replaces `execFile` in tests. */
  readonly run?: DarwinHelperRunner;
  /** Waits between attempts; replaced in tests. */
  readonly delay?: (ms: number) => Promise<void>;
}

/** A batch read failed after every attempt. The message names each attempt's failure. */
export class DarwinProcessDetailsError extends Error {
  override readonly name = "DarwinProcessDetailsError";
}

/** PIDs per helper invocation. Smaller batches keep each timeout short and retries cheap. */
export const DARWIN_DETAILS_BATCH = 128;
/** Attempts per batch before the inventory is declared unavailable. */
export const DARWIN_DETAILS_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [100, 400];
const STDERR_CHARACTERS = 500;

/** Perl startup plus a per-PID allowance; 256 PIDs took at most 125 ms at load average 118. */
export function darwinDetailsTimeout(pids: number): number {
  return 2_000 + 25 * pids;
}

/** The longest valid line is `PID error procargs ERRNO`; leave ample room. */
function darwinDetailsMaxBuffer(pids: number): number {
  return 4_096 + 64 * pids;
}

const defaultRun: DarwinHelperRunner = promisify(execFile) as unknown as DarwinHelperRunner;

const errnoNames = new Map<number, string>(
  Object.entries(constants.errno).map(([name, value]) => [value, name]),
);

function errnoText(value: string): string {
  const name = errnoNames.get(Number(value));
  return name === undefined ? `errno ${value}` : `${name} (${value})`;
}

/**
 * Describes a failed helper run without its command line, which holds the whole script and
 * would push the cause past any log bound.
 */
export function describeHelperFailure(error: unknown): string {
  const failure = error as {
    code?: unknown;
    signal?: unknown;
    killed?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  const overflow = failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  const timedOut = failure.killed === true && !overflow;
  const parts = [
    `exit code ${typeof failure.code === "number" ? failure.code : "none"}`,
    `signal ${typeof failure.signal === "string" ? failure.signal : "none"}`,
    `timed out ${timedOut ? "yes" : "no"}`,
  ];
  if (overflow) parts.push("output exceeded the buffer");
  else if (typeof failure.code === "string") parts.push(`error ${failure.code}`);
  const stderr = String(failure.stderr ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (stderr) parts.push(`stderr: ${stderr.slice(0, STDERR_CHARACTERS)}`);
  else if (failure.code === undefined && typeof failure.message === "string")
    parts.push(failure.message.slice(0, STDERR_CHARACTERS));
  return `macOS process details helper failed (${parts.join(", ")})`;
}

function parseBatch(
  stdout: string,
  requested: ReadonlySet<number>,
): Map<number, DarwinProcessDetails | "denied" | null> {
  const details = new Map<number, DarwinProcessDetails | "denied" | null>();
  const errors: string[] = [];
  const invalid = (line: string) =>
    new Error(`Invalid macOS process details line: ${JSON.stringify(line.slice(0, 80))}`);
  const claim = (line: string, pid: number) => {
    if (!requested.has(pid) || details.has(pid)) throw invalid(line);
  };
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    const status = /^(\d+) (gone|denied)$/.exec(line);
    if (status) {
      const pid = Number(status[1]);
      claim(line, pid);
      details.set(pid, status[2] === "gone" ? null : "denied");
      continue;
    }
    const failed = /^(\d+) error (getsid|procargs) (\d+)$/.exec(line);
    if (failed) {
      const pid = Number(failed[1]);
      claim(line, pid);
      errors.push(`PID ${pid} ${failed[2]} ${errnoText(failed[3] ?? "")}`);
      continue;
    }
    const match = /^(\d+) (\d+) ([01])$/.exec(line);
    const pid = Number(match?.[1]);
    const session = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(session) || session <= 0) throw invalid(line);
    claim(line, pid);
    details.set(pid, { session, marked: match[3] === "1" });
  }
  if (errors.length)
    throw new Error(
      `macOS refused process reads: ${errors.slice(0, 8).join("; ")}${
        errors.length > 8 ? `; and ${errors.length - 8} more` : ""
      }`,
    );
  return details;
}

/** Caller must bracket this read with identity checks before using the results. */
export async function darwinProcessDetails(
  processes: readonly { pid: number; inspectMarker: boolean }[],
  marker?: string,
  options: DarwinProcessDetailsOptions = {},
): Promise<Map<number, DarwinProcessDetails | "denied" | null>> {
  const run = options.run ?? defaultRun;
  const delay =
    options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const details = new Map<number, DarwinProcessDetails | "denied" | null>();
  for (let offset = 0; offset < processes.length; offset += DARWIN_DETAILS_BATCH) {
    const batch = processes.slice(offset, offset + DARWIN_DETAILS_BATCH);
    const requested = new Set(batch.map(({ pid }) => pid));
    const failures: string[] = [];
    let result: Map<number, DarwinProcessDetails | "denied" | null> | undefined;
    // A failed read proves nothing about any PID, so retrying the whole batch is safe.
    for (let attempt = 0; attempt < DARWIN_DETAILS_ATTEMPTS && !result; attempt++) {
      if (attempt > 0) await delay(RETRY_DELAYS_MS[attempt - 1] ?? 400);
      let stdout: string;
      try {
        ({ stdout } = await run(
          "/usr/bin/perl",
          [
            "-T",
            "-e",
            DETAILS,
            "--",
            marker === undefined ? "" : `SUPERTAG_INTERNAL_PROCESS_MARKER=${marker}`,
            ...batch.map(({ pid, inspectMarker }) => `${pid}:${inspectMarker ? 1 : 0}`),
          ],
          {
            // Do not load caller-controlled Perl options, libraries, or startup code.
            env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
            timeout: darwinDetailsTimeout(batch.length),
            maxBuffer: darwinDetailsMaxBuffer(batch.length),
          },
        ).then(({ stdout }) => ({ stdout: String(stdout) })));
      } catch (error) {
        failures.push(describeHelperFailure(error));
        continue;
      }
      try {
        result = parseBatch(stdout, requested);
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    if (!result)
      throw new DarwinProcessDetailsError(
        `macOS process details failed after ${failures.length} attempts: ${failures
          .map((failure, index) => `attempt ${index + 1}: ${failure}`)
          .join("; ")}`,
      );
    for (const [pid, detail] of result) details.set(pid, detail);
  }
  return details;
}
