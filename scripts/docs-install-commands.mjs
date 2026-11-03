// Repository installation is a user workflow during the alpha.
export function isInstallCommand(name, line) {
  return (
    name === "docs/operations/install.md" &&
    /^\s*pnpm (?:install|install:cli|uninstall:cli)\s*$/u.test(line)
  );
}
