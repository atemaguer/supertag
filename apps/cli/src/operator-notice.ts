const STALL_PREFIX =
  "Needs you: owner stalled. SuperTag wrote this notice: the Objective is still working, but no owner activation is running, queued, or waiting, and SuperTag will not start another automatically because ";
const STALL_RECOVERY =
  " Reply with direction to wake the owner, or update or cancel the Objective.";

/** Translate the Control Plane's generated stall notice only for human-readable output. */
export function operatorNotice(text: string): string {
  if (!text.startsWith(STALL_PREFIX)) return text;
  const detail = text.slice(STALL_PREFIX.length).replace(STALL_RECOVERY, "");
  const operatorErrorPrefix = "its last activation failed with an error only an operator can fix (";
  const operatorError = detail.startsWith(operatorErrorPrefix)
    ? detail.slice(operatorErrorPrefix.length).split(").")[0]
    : undefined;
  let recovery: string;
  if (operatorError !== undefined) {
    if (/billing|credit|payment|balance|spend/i.test(operatorError)) {
      recovery = "Fix the provider billing or credit balance before asking the owner to continue.";
    } else if (
      /auth|login|log in|logged in|sign in|api.?key|credential|unauthorized|401|403/i.test(
        operatorError,
      )
    ) {
      recovery =
        "Sign in or fix the provider credentials before asking the owner to continue. For Claude Code, run `claude` and use /login, or set ANTHROPIC_API_KEY. For Codex, run `codex login` or set OPENAI_API_KEY.";
    } else {
      recovery = "Fix the configuration or access error before asking the owner to continue.";
    }
  } else if (
    detail.startsWith("its last activation ended and the Objective waits for new evidence")
  ) {
    recovery = "Provide new evidence or direction when you want the owner to continue.";
  } else {
    recovery =
      "Review the results and resolve the cause, then reply with your next instruction to restart the owner, or cancel the Objective.";
  }
  const cause = detail
    .replace(
      "its last activation failed with an error only an operator can fix",
      "the owner needs your help to fix an error",
    )
    .replace(/\bactivations\b/g, "runs")
    .replace(/\bactivation\b/g, "run")
    .replace(/\bautomatic continuations\b/g, "automatic retries")
    .replace(/\bassessment runs\b/g, "reviews");
  return `Work has stopped because ${cause} ${recovery}`;
}
