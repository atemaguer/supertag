import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "tests/**/*.test.ts"],
    // Harness and environment suites run real child processes against time limits. More
    // workers than CPUs only makes them compete, so a 2-CPU CI runner uses 2, not 4.
    maxWorkers: Math.max(1, Math.min(4, availableParallelism())),
    passWithNoTests: false,
  },
});
