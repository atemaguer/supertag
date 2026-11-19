/**
 * Renders the terminal UI against a `FakeGateway` in OpenTUI's test renderer.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { Alert } from "@supertag/client/model";
import { clearConversationCache, clearOutbox } from "@supertag/client/react";
import { act } from "react";
import { App } from "../src/app";
import { Connections, TuiGateway } from "../src/connection";
import { Controller } from "../src/controller";
import { defaults } from "../src/preferences";
import { FakeGateway, type FakeTag } from "./fake-gateway";

export const TAGS: FakeTag[] = [
  { tagId: "engineer", name: "engineer" },
  { tagId: "lead", name: "lead", lead: true },
  { tagId: "reviewer", name: "reviewer" },
];

export interface Setup {
  fake: FakeGateway;
  controller: Controller;
  alerts: Alert[];
  root: string;
}

/** A controller whose Gateway is the fake; `connect: false` leaves it painting from the cache. */
export function setup(
  fake = new FakeGateway(TAGS),
  options: { root?: string; connect?: boolean } = {},
): Setup {
  const root = options.root ?? mkdtempSync(path.join(tmpdir(), "supertag-tui-test-"));
  const connections = new Connections({
    env: { HOME: root },
    cli: "/nonexistent/supertag",
    buildVersion: "test",
    cacheRoot: path.join(root, "cache"),
    cliStore: path.join(root, "config/supertag/gateways.json"),
    desktopStore: path.join(root, "config/desktop/gateways.json"),
    discoverLocal: async () => ({
      running: true,
      url: "http://127.0.0.1:1",
      token: "operator-token",
      stateDirectory: path.join(root, "state"),
      setUp: true,
      machineId: null,
    }),
  });
  const controller = new Controller(connections, defaults(), undefined);
  const scope = fake.scope(`local ${path.join(root, "state")}`);
  const gateway = new TuiGateway(connections, "local", "local", scope);
  controller.gateway = gateway;
  controller.entry = { id: "local", name: "Local", detail: "", kind: "local", available: true };
  if (options.connect !== false) {
    const connectionId = connections.state.adopt(fake.session(), "local", scope);
    gateway.attach(connectionId);
    controller.status = { kind: "connected", principal: fake.principal };
  } else {
    controller.status = { kind: "connecting" };
  }
  return { fake, controller, alerts: [], root };
}

export async function render(
  given: Setup,
  size: { width: number; height: number } = { width: 120, height: 40 },
) {
  const view = await testRender(
    <App
      controller={given.controller}
      onQuit={() => {}}
      notifyLevel="all"
      onAlert={(alert) => given.alerts.push(alert)}
    />,
    { ...size, nativeSceneVerify: false },
  );
  // The screens update from streams as they run, outside `act`, so React warns only inside it.
  const actEnvironment = (on: boolean) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = on;
  };
  actEnvironment(false);
  const inAct = async (work: () => void | Promise<void>) => {
    actEnvironment(true);
    try {
      await act(async () => {
        await work();
      });
    } finally {
      actEnvironment(false);
    }
  };
  const settle = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) {
      await inAct(() => new Promise((resolve) => setTimeout(resolve, 10)));
      await view.renderOnce();
    }
  };
  const frame = () => view.captureCharFrame();
  /** Settles until the frame contains `text`, or fails with the last frame. */
  const waitFor = async (text: string | RegExp, rounds = 100) => {
    for (let i = 0; i < rounds; i++) {
      await settle(1);
      const shown = frame();
      if (typeof text === "string" ? shown.includes(text) : text.test(shown)) return shown;
    }
    throw new Error(`never showed ${text}:\n${frame()}`);
  };
  const press = async (
    key: string,
    modifiers?: { ctrl?: boolean; meta?: boolean; shift?: boolean },
  ) => {
    await inAct(() => view.mockInput.pressKey(key, modifiers));
    await settle(2);
  };
  const type = async (text: string) => {
    await inAct(() => view.mockInput.typeText(text));
    await settle(2);
  };
  const close = async () => {
    given.controller.close();
    await view.dispose();
  };
  return { view, settle, frame, waitFor, press, type, close };
}

export function reset(given?: Setup) {
  clearConversationCache();
  clearOutbox();
  if (given) rmSync(given.root, { recursive: true, force: true });
}
