import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DescService } from "@bufbuild/protobuf";
import { createConnectRouter } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { registerOperatorRoutes } from "../apps/cli/src/operator-rpc.ts";
import {
  OPERATOR_READ_STORE_METHODS,
  OPERATOR_RPC_CLASSES,
  operatorRpcClass,
} from "../apps/cli/src/operator-seams.ts";
import * as operatorApi from "../packages/operator-api/src/index.ts";

const SOURCE = join(import.meta.dirname, "../apps/cli/src");

/** The modules implementing operator services; each serves `read` RPCs. */
const SERVICE_MODULES = [
  "conversation-rpc.ts",
  "event-rpc.ts",
  "inbox-rpc.ts",
  "mailbox-rpc.ts",
  "objective-rpc.ts",
  "organization-rpc.ts",
  "team-rpc.ts",
  "work-rpc.ts",
];

/** Where the narrow interfaces are defined from the full store and Control Plane types. */
const SEAMS_MODULE = "operator-seams.ts";

/** Names a service module must not import from a package: the runtime and the full store. */
const FORBIDDEN_NAMES: Readonly<Record<string, readonly string[]>> = {
  "@supertag/control-plane": ["ControlPlane", "ObjectiveController", "ChangeNotifications"],
  "@supertag/core": ["Store"],
};
const FORBIDDEN_PACKAGES = ["@supertag/store"];
/** Local modules that hold the runtime, the full store, or the router itself. */
const FORBIDDEN_MODULES = [
  "control-plane-api.ts",
  "control-plane-runtime.ts",
  "operator-control-plane.ts",
  "operator-rpc.ts",
];

interface Import {
  readonly from: string;
  readonly names: readonly string[];
}

function imports(file: string): Import[] {
  const source = readFileSync(join(SOURCE, file), "utf8");
  return [
    ...source.matchAll(/^(?:import|export)\s+(?:type\s+)?([^;]*?)\s+from\s+"([^"]+)";/gmu),
  ].map(([, clause = "", from = ""]) => ({
    from,
    names: (/\{([\s\S]*)\}/u.exec(clause)?.[1] ?? clause)
      .split(",")
      .map(
        (name) =>
          name
            .replace(/^\s*type\s+/u, "")
            .split(/\s+as\s+/u)[0]
            ?.trim() ?? "",
      )
      .filter((name) => name !== "" && name !== "*"),
  }));
}

function localModule(from: string): string | undefined {
  return from.startsWith("./") ? from.slice(2).replace(/\.js$/u, ".ts") : undefined;
}

describe("the operator RPC seams", () => {
  const router = createConnectRouter();
  registerOperatorRoutes(router, {
    store: {} as never,
    queries: {} as never,
    writes: {} as never,
    control: {} as never,
    changes: {} as never,
    follows: {} as never,
    draining: () => new AbortController().signal,
  });
  const registered = router.handlers.map(
    (handler) => `${handler.method.parent.typeName}/${handler.method.name}`,
  );

  it("registers every operator service, and classes every RPC exactly once", () => {
    const services = Object.values(operatorApi).filter(
      (value): value is DescService =>
        typeof value === "object" && value !== null && "kind" in value && value.kind === "service",
    );
    const declared = services.flatMap((service) =>
      service.methods.map((method) => `${service.typeName}/${method.name}`),
    );
    expect(registered.toSorted()).toEqual(declared.toSorted());
    expect(Object.keys(OPERATOR_RPC_CLASSES).toSorted()).toEqual(registered.toSorted());
    for (const handler of router.handlers) expect(operatorRpcClass(handler.method)).toBeDefined();
  });

  it("gives the read store only reads", () => {
    for (const method of OPERATOR_READ_STORE_METHODS)
      expect(method).toMatch(/^(find|get|has|list)|Summaries$/u);
  });

  it("keeps service modules off the Control Plane runtime and the full store", () => {
    const seen = new Set<string>();
    const pending = [...SERVICE_MODULES];
    const violations: string[] = [];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (seen.has(file)) continue;
      seen.add(file);
      for (const { from, names } of imports(file)) {
        const local = localModule(from);
        if (local !== undefined) {
          if (FORBIDDEN_MODULES.includes(local)) violations.push(`${file} imports ${local}`);
          else if (local !== SEAMS_MODULE) pending.push(local);
          continue;
        }
        if (FORBIDDEN_PACKAGES.includes(from)) violations.push(`${file} imports ${from}`);
        for (const name of names)
          if (FORBIDDEN_NAMES[from]?.includes(name))
            violations.push(`${file} imports ${name} from ${from}`);
      }
    }
    expect(seen).toContain("message-follow.ts");
    expect(seen).toContain("conversation-messages.ts");
    expect(seen).toContain("work-views.ts");
    expect(seen).toContain("task-storage.ts");
    expect(violations).toEqual([]);
  });

  it("defines the seams from types alone, without the runtime or the in-memory feed", () => {
    for (const { from, names } of imports(SEAMS_MODULE)) {
      expect(localModule(from)).toBeUndefined();
      expect(names).not.toContain("ControlPlane");
      expect(names).not.toContain("ChangeNotifications");
    }
    expect(readFileSync(join(SOURCE, SEAMS_MODULE), "utf8")).not.toMatch(/^import (?!type )/mu);
  });
});
