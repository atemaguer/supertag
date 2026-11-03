#!/usr/bin/env node

process.env["SUPERTAG_CLI_VERSION"] = "0.2.0-alpha.3";
process.env["SUPERTAG_EMBEDDED_CLI"] = "1";

const { cliFailureExitCode, formatCliFailure, main } = await import(
  "../../../apps/cli/src/index.js"
);

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(formatCliFailure(error));
    process.exitCode = cliFailureExitCode(error);
  },
);
