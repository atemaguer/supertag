/**
 * The main process's logging, which must never throw. An app opened from Finder has no terminal,
 * and one started from a terminal or a test outlives the pipe it was given: writing to a closed
 * stdout or stderr fails later, as an `error` event on the stream (EPIPE), which nothing handles
 * unless this does, and Electron shows it as an uncaught exception. So the standard streams'
 * write errors are dropped, and the app's own log lines go to a file in its logs directory as
 * well.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

/** A standard stream, as far as dropping its write errors goes. */
interface Stream {
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** Drops the write errors of stdout and stderr, such as EPIPE once their reader is gone. */
export function guardStdio(streams: readonly Stream[] = [process.stdout, process.stderr]) {
  for (const stream of streams) stream.on("error", () => {});
}

/** One log line: the time, the level, and the message with any error's stack. */
export function logLine(level: string, parts: readonly unknown[], now = new Date()): string {
  const text = parts
    .map((part) => (typeof part === "string" ? part : inspect(part, { depth: 4 })))
    .join(" ");
  return `${now.toISOString()} ${level} ${text}\n`;
}

/** Appends log lines to a file, and to stderr while it has a reader; never throws. */
export class FileLog {
  private ready = false;

  constructor(
    readonly file: string,
    private readonly echo: (line: string) => void = (line) => {
      process.stderr.write(line);
    },
  ) {}

  private write(level: string, parts: readonly unknown[]) {
    const line = logLine(level, parts);
    try {
      if (!this.ready) {
        mkdirSync(path.dirname(this.file), { recursive: true });
        this.ready = true;
      }
      appendFileSync(this.file, line, { mode: 0o600 });
    } catch {
      // Nowhere to write it; the app goes on.
    }
    try {
      this.echo(line);
    } catch {
      // A closed stderr.
    }
  }

  info = (...parts: unknown[]) => this.write("info", parts);
  warn = (...parts: unknown[]) => this.write("warn", parts);
  error = (...parts: unknown[]) => this.write("error", parts);
  debug = () => {};
}
