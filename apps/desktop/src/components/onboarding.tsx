import { Check, CircleAlert, FolderOpen, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SetupCheck, SetupHarness } from "../gateway";
import { describe } from "../lib/polling";
import { CopyText } from "./conversation-entry";
import { openExternal } from "./external-link";
import { Button } from "./ui/button";

/** The harnesses first launch offers, in order. The others are set up with the CLI. */
const OFFERED: readonly [string, string][] = [
  ["codex", "Codex"],
  ["claude-code", "Claude Code"],
];

export interface SetupApi {
  check(directory?: string, harness?: string): Promise<SetupCheck>;
  chooseFolder(): Promise<string | null>;
  setUp(directory: string, harness: string): Promise<unknown>;
}

/** Whether the chosen folder can hold a Workspace, and what to do when it can't. */
export function repositoryLine(check?: SetupCheck): { ok: boolean; text: string } | undefined {
  const repository = check?.repository;
  if (!repository) return undefined;
  if (repository.git && repository.has_commits)
    return {
      ok: true,
      text: `${repository.name ?? repository.root ?? repository.directory}${repository.branch ? ` · ${repository.branch}` : ""}`,
    };
  return { ok: false, text: repository.fix ?? "Choose a git repository with at least one commit." };
}

/** One harness's state, in words. */
export function harnessState(harness: SetupHarness | undefined): {
  ready: boolean;
  text: string;
} {
  if (!harness) return { ready: false, text: "Checking…" };
  if (!harness.installed) return { ready: false, text: "Not installed" };
  if (harness.node && !harness.node.ok) return { ready: false, text: "Needs Node.js" };
  if (harness.signed_in === true) return { ready: true, text: "Signed in" };
  if (harness.signed_in === false) return { ready: false, text: "Not signed in" };
  return { ready: false, text: "Couldn't check the sign-in" };
}

/**
 * First launch, with no SuperTag on this Mac yet: choose the project folder and the harness,
 * fix what the checks find, and set SuperTag up. The supertag CLI does the checks and the setup.
 */
export function Onboarding({
  api,
  initial,
  onReady,
}: {
  api: SetupApi;
  /** The first check, made before any folder was chosen. */
  initial: SetupCheck;
  /** SuperTag is set up and running. */
  onReady(): void;
}) {
  const [check, setCheck] = useState<SetupCheck>(initial);
  const [directory, setDirectory] = useState<string>();
  const [harness, setHarness] = useState("codex");
  const [checking, setChecking] = useState<string>();
  const [settingUp, setSettingUp] = useState(false);
  const [error, setError] = useState("");
  const setUpButton = useRef<HTMLButtonElement>(null);

  // One check at a time: a check runs sign-in probes and can take seconds, and a second one
  // started meanwhile would only race it.
  const inFlight = useRef(false);

  async function recheck(next = directory, only?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(only ?? "all");
    setError("");
    try {
      const result = await api.check(next, only);
      setCheck((prior) =>
        only && result.harnesses
          ? {
              ...prior,
              ...result,
              harnesses: (prior.harnesses ?? []).map(
                (entry) =>
                  result.harnesses?.find((fresh) => fresh.harness === entry.harness) ?? entry,
              ),
            }
          : result,
      );
      if (!only) {
        const ready = result.harnesses?.find(
          (entry) => OFFERED.some(([id]) => id === entry.harness) && harnessState(entry).ready,
        );
        if (ready && !harnessState(result.harnesses?.find((h) => h.harness === harness)).ready)
          setHarness(ready.harness);
      }
    } catch (error) {
      setError(describe(error));
    } finally {
      inFlight.current = false;
      setChecking(undefined);
    }
  }

  async function choose() {
    setError("");
    try {
      const folder = await api.chooseFolder();
      if (!folder) return;
      setDirectory(folder);
      await recheck(folder);
    } catch (error) {
      setError(describe(error));
    }
  }

  async function setUp() {
    if (!directory) return;
    setSettingUp(true);
    setError("");
    try {
      await api.setUp(directory, harness);
      onReady();
    } catch (error) {
      setError(describe(error));
      setSettingUp(false);
    }
  }

  const repository = repositoryLine(check);
  const chosen = harnessState(check.harnesses?.find((entry) => entry.harness === harness));
  const canSetUp = Boolean(directory && repository?.ok && chosen.ready && !settingUp && !checking);
  // Once everything checks out, Enter sets SuperTag up.
  useEffect(() => {
    if (canSetUp) setUpButton.current?.focus();
  }, [canSetUp]);

  if (check.cli === null)
    return (
      <section className="onboarding" aria-labelledby="onboarding-heading">
        <h2 id="onboarding-heading">{check.outdated ? "Update SuperTag" : "Install SuperTag"}</h2>
        <p>
          {check.outdated
            ? `The supertag command-line tool at ${check.outdated} is older than this app. Run this in Terminal to update it, then check again:`
            : "SuperTag runs on this Mac through its command-line tool. Run this in Terminal, then check again:"}
        </p>
        {check.install && (
          <div className="branch-command">
            <code title={check.install}>{check.install}</code>
            <CopyText text={check.install} label="Copy command" />
          </div>
        )}
        {error && <p className="field-error">{error}</p>}
        <div className="onboarding-actions">
          <Button className="primary" disabled={Boolean(checking)} onClick={() => void recheck()}>
            {checking ? "Checking…" : "Check again"}
          </Button>
        </div>
      </section>
    );

  return (
    <section className="onboarding" aria-labelledby="onboarding-heading">
      <h2 id="onboarding-heading">Set up SuperTag</h2>
      <p>Choose the project your Tags work in and the coding agent they run on.</p>

      <h3>Project</h3>
      <div className="onboarding-row">
        <Button
          // The first thing to do; Enter opens the folder picker.
          autoFocus
          variant="outline"
          className="secondary"
          disabled={settingUp}
          onClick={() => void choose()}
        >
          <FolderOpen size={15} aria-hidden />{" "}
          {directory ? "Choose another folder…" : "Choose folder…"}
        </Button>
        {directory && (
          <span className="onboarding-path" title={directory}>
            {directory}
          </span>
        )}
      </div>
      {repository && (
        <p className={repository.ok ? "onboarding-ok" : "onboarding-fix"} role="status">
          {repository.ok ? <Check size={14} aria-hidden /> : <CircleAlert size={14} aria-hidden />}{" "}
          {repository.text}
        </p>
      )}

      <h3>Coding agent</h3>
      <ul className="onboarding-harnesses" aria-label="Coding agents">
        {OFFERED.map(([id, label]) => {
          const entry = check.harnesses?.find((candidate) => candidate.harness === id);
          const state = harnessState(entry);
          return (
            <li key={id} data-ready={state.ready}>
              <label>
                <input
                  type="radio"
                  name="harness"
                  value={id}
                  checked={harness === id}
                  disabled={!state.ready || settingUp}
                  onChange={() => setHarness(id)}
                />
                <span className="onboarding-harness-name">{label}</span>
                <span className="onboarding-harness-state">
                  {checking === id || checking === "all" ? "Checking…" : state.text}
                </span>
              </label>
              {entry && !state.ready && (
                <div className="onboarding-fix-line">
                  {(entry.node && !entry.node.ok ? entry.node.fix : entry.fix) && (
                    <p>{entry.node && !entry.node.ok ? entry.node.fix : entry.fix}</p>
                  )}
                  {entry.fix_command && (
                    <div className="branch-command">
                      <code title={entry.fix_command}>{entry.fix_command}</code>
                      <CopyText text={entry.fix_command} label="Copy command" />
                    </div>
                  )}
                  <div className="onboarding-row">
                    {!entry.installed && entry.install_url && (
                      <Button
                        variant="outline"
                        className="secondary"
                        onClick={() => openExternal(entry.install_url as string)}
                      >
                        Install {label}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      className="secondary"
                      disabled={Boolean(checking) || settingUp}
                      onClick={() => void recheck(directory, id)}
                    >
                      Check again
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="onboarding-actions">
        <Button
          ref={setUpButton}
          className="primary"
          disabled={!canSetUp}
          onClick={() => void setUp()}
        >
          {settingUp ? (
            <>
              <LoaderCircle size={15} className="spin" aria-hidden /> Setting up…
            </>
          ) : (
            "Set up and start"
          )}
        </Button>
      </div>
      {settingUp && (
        <p className="onboarding-note" role="status">
          Writing the configuration and starting SuperTag. This can take a minute.
        </p>
      )}
    </section>
  );
}
