import { describe, expect, it } from "vitest";
import { elapsedText, plainCommandText } from "./command-activity.js";

describe("plainCommandText", () => {
  it("keeps an ordinary command unchanged", () => {
    expect(plainCommandText("pnpm test:verify -- --reporter=dot")).toBe(
      "pnpm test:verify -- --reporter=dot",
    );
  });

  it("removes ANSI CSI and OSC sequences", () => {
    expect(plainCommandText("\x1b[31mrm -rf\x1b[0m build")).toBe("rm -rf build");
    expect(plainCommandText("echo \x1b]0;owned\x07done")).toBe("echo done");
    expect(plainCommandText("echo \x1b]8;;https://x.test\x1b\\link")).toBe("echo link");
    expect(plainCommandText("\x1b[2J\x1b[Hclear")).toBe("clear");
  });

  it("replaces C0, C1, DEL, format, and line separator characters", () => {
    // Invisible characters are built from code points so the source shows none of them.
    const [rtl, lineSeparator, paragraphSeparator, zeroWidth, bom] = [
      0x202e, 0x2028, 0x2029, 0x200b, 0xfeff,
    ].map((code) => String.fromCodePoint(code));
    const value = plainCommandText(
      `a\x00b\x07c\x08d\re\nf\tg\x7fh\u009b31mi${rtl}j${lineSeparator}k${paragraphSeparator}l${zeroWidth}m${bom}n`,
    );
    expect(value).toBe("a b c d e f g h 31mi j k l m n");
    expect(value).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });

  it("leaves no escape character from a lone or truncated ESC", () => {
    expect(plainCommandText("x\x1b")).toBe("x");
    expect(plainCommandText("x\x1b[")).toBe("x [");
  });

  it("cuts long text by code point and marks it with an ellipsis", () => {
    expect(plainCommandText("abcdefghij", 6)).toBe("abcde…");
    expect(plainCommandText("😀😀😀😀", 3)).toBe("😀😀…");
    expect(plainCommandText("abc", 3)).toBe("abc");
  });

  it("returns an empty string when nothing printable remains", () => {
    expect(plainCommandText("\x1b[0m\x00\n")).toBe("");
  });
});

describe("elapsedText", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(elapsedText(-5)).toBe("0s");
    expect(elapsedText(45_900)).toBe("45s");
    expect(elapsedText(24 * 60_000 + 30_000)).toBe("24m");
    expect(elapsedText(125 * 60_000)).toBe("2h 5m");
  });
});
