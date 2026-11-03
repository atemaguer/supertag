// Vitest reporter used by `pnpm test:verify`. The JSON reporter omits unhandled errors
// (errors raised outside any test file), so this records them, and how the run ended, to
// the file named by SUPERTAG_TEST_VERIFY_ERRORS_FILE.
import { writeFileSync } from "node:fs";

export default class TestVerifyReporter {
  onTestRunEnd(_testModules, unhandledErrors, reason) {
    const path = process.env.SUPERTAG_TEST_VERIFY_ERRORS_FILE;
    if (!path) return;
    const errors = [...(unhandledErrors ?? [])].map((error) =>
      String(error?.message ?? error?.name ?? error).slice(0, 500),
    );
    writeFileSync(path, JSON.stringify({ reason: reason ?? null, unhandledErrors: errors }));
  }
}
