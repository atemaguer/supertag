import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
}

/** Line-based questions for setup wizards; works on a terminal and on scripted input. */
export interface Prompter {
  choose<T extends string>(
    question: string,
    choices: readonly Choice<T>[],
    defaultValue: T,
  ): Promise<T>;
  chooseMany<T extends string>(
    question: string,
    choices: readonly Choice<T>[],
    defaults: readonly T[],
  ): Promise<readonly T[]>;
  text(
    question: string,
    defaultValue: string,
    validate?: (value: string) => string | undefined | Promise<string | undefined>,
  ): Promise<string>;
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  close(): void;
}

/**
 * A prompter over readline. Lines that arrive before a question is asked wait in a queue, so
 * scripted input answers each question in order.
 */
export function linePrompter(input: Readable, output: Writable): Prompter {
  const lines: string[] = [];
  const waiting: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  let closed = false;
  const readline = createInterface({ input, terminal: false });
  readline.on("line", (line) => {
    const next = waiting.shift();
    if (next) next.resolve(line);
    else lines.push(line);
  });
  readline.on("close", () => {
    closed = true;
    for (const next of waiting.splice(0))
      next.reject(new Error("Input ended before setup finished. Nothing more was changed."));
  });
  const ask = (prompt: string): Promise<string> => {
    output.write(prompt);
    const line = lines.shift();
    if (line !== undefined) {
      output.write("\n");
      return Promise.resolve(line.trim());
    }
    if (closed)
      return Promise.reject(
        new Error("Input ended before setup finished. Nothing more was changed."),
      );
    return new Promise((resolve, reject) =>
      waiting.push({ resolve: (value) => resolve(value.trim()), reject }),
    );
  };
  const list = <T extends string>(question: string, choices: readonly Choice<T>[]) => {
    output.write(`\n${question}\n`);
    choices.forEach((choice, index) => {
      output.write(`  ${index + 1}) ${choice.label}\n`);
    });
  };
  return {
    async choose(question, choices, defaultValue) {
      list(question, choices);
      const fallback = choices.findIndex((choice) => choice.value === defaultValue) + 1;
      for (;;) {
        const answer = await ask(`Choose 1-${choices.length} [${fallback}]: `);
        if (answer === "") return defaultValue;
        const index = Number(answer);
        const choice = Number.isInteger(index) ? choices[index - 1] : undefined;
        if (choice !== undefined) return choice.value;
        output.write(`Enter a number from 1 to ${choices.length}.\n`);
      }
    },
    async chooseMany<T extends string>(
      question: string,
      choices: readonly Choice<T>[],
      defaults: readonly T[],
    ): Promise<readonly T[]> {
      list(question, choices);
      const fallback = choices
        .flatMap((choice, index) => (defaults.includes(choice.value) ? [index + 1] : []))
        .join(",");
      for (;;) {
        const answer = await ask(`Choose numbers separated by commas [${fallback}]: `);
        if (answer === "") return defaults;
        const picked = answer
          .split(/[\s,]+/u)
          .filter(Boolean)
          .map(Number);
        const values = picked.map((index) =>
          Number.isInteger(index) ? choices[index - 1]?.value : undefined,
        );
        if (values.length > 0 && values.every((value) => value !== undefined))
          return [...new Set(values as T[])];
        output.write(`Enter numbers from 1 to ${choices.length}, such as 1,2.\n`);
      }
    },
    async text(question, defaultValue, validate) {
      for (;;) {
        const shown = defaultValue === "" ? "" : ` [${defaultValue}]`;
        const answer = (await ask(`\n${question}${shown}: `)) || defaultValue;
        const problem = await validate?.(answer);
        if (problem === undefined) return answer;
        output.write(`${problem}\n`);
      }
    },
    async confirm(question, defaultValue) {
      for (;;) {
        const answer = (
          await ask(`\n${question} ${defaultValue ? "[Y/n]" : "[y/N]"}: `)
        ).toLowerCase();
        if (answer === "") return defaultValue;
        if (answer === "y" || answer === "yes") return true;
        if (answer === "n" || answer === "no") return false;
        output.write("Answer y or n.\n");
      }
    },
    close() {
      readline.close();
    },
  };
}
