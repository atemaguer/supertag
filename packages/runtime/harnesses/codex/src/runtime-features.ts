export function codexRuntimeFeatures(
  actions: readonly string[],
): Readonly<Record<string, boolean>> {
  const commands = actions.includes("commands:execute");
  const browser = actions.includes("browser:use");
  return {
    // Codex exposes delegation as an internal `codex` MCP server. Keep every
    // delegation feature disabled until child tools can be scoped separately.
    multi_agent: false,
    multi_agent_v2: false,
    enable_fanout: false,
    // Apps and plugins can introduce additional MCP servers outside the
    // Permission Set assembled by the Worker.
    apps: false,
    enable_mcp_apps: false,
    plugins: false,
    plugin_sharing: false,
    skill_mcp_dependency_install: false,
    shell_tool: commands,
    unified_exec: commands,
    browser_use: browser,
    browser_use_external: browser,
    computer_use: browser,
    in_app_browser: browser,
  };
}
