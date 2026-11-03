import { chmod, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HarnessProviderError } from "@supertag/worker-sdk";

export async function prepareCodexHome(
  codexHome: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | undefined> {
  await mkdir(codexHome, { recursive: true });
  const codexApiKey = environment["CODEX_API_KEY"]?.trim();
  if (codexApiKey) return codexApiKey;
  const source = codexAuthFilePath(environment);
  const destination = join(codexHome, "auth.json");
  try {
    await copyFile(source, destination);
    await chmod(destination, 0o600);
    return undefined;
  } catch (error) {
    const openAiApiKey = environment["OPENAI_API_KEY"]?.trim();
    if (openAiApiKey) return openAiApiKey;
    throw new HarnessProviderError(
      "Codex SDK requires OPENAI_API_KEY, CODEX_API_KEY, or a file-backed Codex sign-in",
      { cause: error },
    );
  }
}

export function codexAuthFilePath(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const sourceHome =
    environment["CODEX_HOME"]?.trim() || join(environment["HOME"]?.trim() || homedir(), ".codex");
  return join(sourceHome, "auth.json");
}
