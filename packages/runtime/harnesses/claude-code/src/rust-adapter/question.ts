import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Code, ConnectError } from "@connectrpc/connect";
import { z } from "zod";
import { redact } from "./checkpoint.js";
import { type harnessClient, receipt } from "./client.js";

export const QUESTION_SERVER = "supertag";
export const QUESTION_TOOL = `mcp__${QUESTION_SERVER}__ask`;
const OPERATION_ID = "claude-objective-question";
const MAX_TEXT_LENGTH = 16_000;

function trim(text: string) {
  return text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

export const questionArguments = z.strictObject({
  text: z
    .string()
    .min(1)
    .max(MAX_TEXT_LENGTH)
    .refine((text) => trim(text).length > 0 && !text.includes("\0"), "Provide a question."),
});

interface QuestionScope {
  taskId: string;
  attemptId: string;
  secrets: readonly string[];
  signal: AbortSignal;
  active(): boolean;
}

function response(text: string, failed = false) {
  return { content: [{ type: "text" as const, text }], ...(failed ? { isError: true } : {}) };
}

export function questionServer(
  { questions, options }: ReturnType<typeof harnessClient>,
  scope: QuestionScope,
) {
  const server = createSdkMcpServer({
    name: QUESTION_SERVER,
    version: "1",
    timeout: 16_000,
    tools: [],
  });
  // Register an object schema so extra fields are rejected before the handler.
  server.instance.registerTool(
    "ask",
    {
      description:
        "Record one question for the Objective's operator. After it is recorded, finish this turn. The answer can arrive in a later turn.",
      inputSchema: questionArguments,
      _meta: { "anthropic/alwaysLoad": true },
    },
    async ({ text }, call) => {
      const safe = trim(redact(text, scope.secrets));
      if (!questionArguments.safeParse({ text: safe }).success)
        return response("Provide a valid Objective question.", true);
      const signal = AbortSignal.any([scope.signal, call.signal]);
      try {
        // The Control Plane allows one question per Attempt and binds the receipt to its text.
        const input = { operationId: OPERATION_ID, text: safe };
        const stored = await receipt(() => {
          if (!scope.active() || signal.aborted)
            throw new ConnectError("Attempt closed", Code.Canceled);
          return questions.askQuestion(input, { ...options(), signal });
        });
        if (
          stored.taskId === scope.taskId &&
          stored.attemptId === scope.attemptId &&
          stored.objectiveId &&
          stored.text === safe
        )
          return response("Objective question recorded.");
      } catch (error) {
        if (ConnectError.from(error).code === Code.AlreadyExists)
          return response("This Attempt already recorded a different Objective question.", true);
      }
      return response("The Objective question could not be confirmed.", true);
    },
  );
  return server;
}
