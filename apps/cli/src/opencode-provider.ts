export function openCodeProviderEnvironment(
  model: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  const variables: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
    groq: "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    azure: "AZURE_OPENAI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    xai: "XAI_API_KEY",
  };
  const name = variables[model?.split("/")[0] ?? ""];
  if (!name) return {};
  const value = environment[name];
  return value ? { [name]: value } : {};
}
