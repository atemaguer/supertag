import { type CursorModelCheckResult, checkCursorModels } from "../index.js";

/**
 * The Rust Worker Host's Cursor model check: list models with CURSOR_API_KEY through the SDK and
 * write one JSON result line. No prompt is sent. Failure messages are redacted by the check.
 */
export async function writeModelCheck(
  models: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  write: (line: string) => void,
  check: typeof checkCursorModels = checkCursorModels,
): Promise<CursorModelCheckResult> {
  const apiKey = environment["CURSOR_API_KEY"]?.trim();
  const result = await check(models, apiKey ? { apiKey } : {});
  write(`${JSON.stringify(result)}\n`);
  return result;
}
