/**
 * Translates the public action-first CLI into the established internal command handlers.
 * The returned form is an implementation detail and must never appear in user-facing help.
 */
export function normalizeActionFirstCommand(args: readonly string[]): string[] {
  const [action, resource, ...rest] = args;
  if (action === undefined) return [];
  if (action === "help") {
    if (resource === undefined) return ["--help"];
    return normalizeActionFirstCommand([resource, ...rest, "--help"]);
  }
  if (resource === undefined) return [...args];

  if (action === "apply" || action === "diff") {
    // `supertag apply -f FILE`.
    if (resource.startsWith("-")) return [action, resource, ...rest];
  }
  if (action === "migrate" && resource === "database") return ["migrate", ...rest];
  if (resource === "deployment") {
    if (action === "setup" || action === "check" || action === "verify") {
      return ["deploy", action, ...rest];
    }
  }
  if (resource === "surface" && action === "setup") {
    const [provider, ...options] = rest;
    return provider === undefined ? [...args] : ["setup", provider, ...options];
  }

  if (resource === "artifact" && ["list", "get", "download"].includes(action))
    return ["artifact", action, ...rest];
  if (action === "assign" && resource === "task") return ["task", "assign", ...rest];
  if (action === "list" && resource === "approval") return ["approval", "list", ...rest];
  if (action === "watch" && resource === "inbox")
    return ["coordinate", "inbox", "--watch", ...canonicalCoordination(rest)];
  if ((action === "approve" || action === "deny") && resource === "request")
    return ["approval", action, ...rest];
  if (action === "approve" && resource === "objective") return ["objective", "approve", ...rest];
  if (action === "start" && resource === "objective") return ["objective", "start", ...rest];
  if (action === "watch" && resource === "objective") return ["objective", "watch", ...rest];
  if (action === "message" && resource === "objective") return ["objective", "message", ...rest];
  if (action === "message" && resource === "tag") return ["tag", "message", ...rest];

  if (resource === "auth-key" && (action === "create" || action === "revoke"))
    return ["auth-key", action, ...rest];
  if (resource === "operator-token" && (action === "create" || action === "revoke"))
    return ["operator-token", action, ...rest];
  if (action === "create") {
    if (resource === "tag") return ["tag", "create", ...rest];
    if (resource === "objective") return ["objective", "create", ...rest];
    if (resource === "team")
      return [
        "team",
        "create",
        ...renameOption(
          normalizeRepeated(rest, "member", "members"),
          "max-concurrency",
          "concurrency",
        ),
      ];
  }

  if (action === "list") {
    if (resource === "objective") {
      const selected = takeOption(rest, "owner");
      return selected.value === undefined
        ? [...args]
        : ["objective", "list", selected.value, ...selected.rest];
    }
    if (resource === "team") return ["team", "list", ...rest];
    if (resource === "workstream") {
      const selected = takeOption(rest, "tag");
      return selected.value === undefined
        ? [...args]
        : ["workstream", "list", selected.value, ...selected.rest];
    }
    if (resource === "workstream-post") {
      const selected = takeOption(rest, "workstream");
      return selected.value === undefined
        ? [...args]
        : ["workstream", "posts", selected.value, ...selected.rest];
    }
    if (resource === "message") {
      const selected = takeOption(rest, "mailbox");
      return selected.value === undefined
        ? [...args]
        : ["tag", "messaging", "history", selected.value, ...selected.rest];
    }
    if (resource === "mailbox-grant") {
      const selected = takeOption(rest, "mailbox");
      return selected.value === undefined
        ? [...args]
        : ["tag", "messaging", "grants", selected.value, ...selected.rest];
    }
    if (resource === "inbox") return ["coordinate", "inbox", ...canonicalCoordination(rest)];
    if (resource === "control-plane") return ["control-plane", "list", ...rest];
    if (resource === "surface") return ["get", "surface-account", ...rest];
    if (LISTABLE_RESOURCES.has(resource)) return ["get", resource, ...rest];
  }

  if (action === "get") {
    if (resource === "control-plane" && rest.includes("--current")) {
      return ["control-plane", "current", ...rest.filter((value) => value !== "--current")];
    }
    // A YAML manifest comes from the resource reader, like other declarable kinds.
    if (resource === "objective" && !wantsYaml(rest)) return ["objective", "get", ...rest];
    if (resource === "workstream") return ["workstream", "get", ...rest];
    if (resource === "surface") return ["get", "surface-account", ...rest];
  }
  if (action === "delete" && resource === "surface") return ["delete", "surface-account", ...rest];

  if (action === "describe" && resource === "objective") {
    const [id, ...options] = rest;
    return id === undefined ? [...args] : ["objective", "get", id, "--overview", ...options];
  }

  if (action === "update") {
    if (resource === "objective") {
      const [id, ...options] = rest;
      const selected = takeOption(options, "status");
      if (id !== undefined && selected.value === undefined && options.length > 0)
        // Deadline or budget update without a status change.
        return ["objective", "status", id, ...options];
      return id === undefined || selected.value === undefined
        ? [...args]
        : ["objective", "status", id, canonicalStatus(selected.value), ...selected.rest];
    }
    if (resource === "team") {
      return [
        "team",
        "update",
        ...renameOption(
          normalizeRepeated(rest, "member", "members"),
          "max-concurrency",
          "concurrency",
        ),
      ];
    }
    if (resource === "tag") {
      const [name, ...options] = rest;
      const addedWorkerHost = takeOption(options, "add-worker-host");
      if (name !== undefined && addedWorkerHost.value !== undefined)
        return ["tag", "bind-worker-host", name, addedWorkerHost.value, ...addedWorkerHost.rest];
      const removedWorkerHost = takeOption(options, "remove-worker-host");
      if (name !== undefined && removedWorkerHost.value !== undefined)
        return [
          "tag",
          "unbind-worker-host",
          name,
          removedWorkerHost.value,
          ...removedWorkerHost.rest,
        ];
      const added = takeOption(options, "add-location");
      if (name !== undefined && added.value !== undefined)
        return ["tag", "add", name, added.value, ...added.rest];
      const removed = takeOption(options, "remove-location");
      if (name !== undefined && removed.value !== undefined)
        return ["tag", "remove", name, removed.value, ...removed.rest];
    }
  }

  if (action === "complete" && resource === "objective") {
    const [id, ...options] = rest;
    return id === undefined ? [...args] : ["objective", "status", id, "completed", ...options];
  }
  if (action === "dissolve" && resource === "team") return ["team", "dissolve", ...rest];
  if (action === "events" && resource === "team") return ["team", "history", ...rest];
  if (action === "events" && resource === "task") return ["task", "events", ...rest];
  if (action === "cancel" && resource === "task") return ["task", "cancel", ...rest];
  if (action === "cancel" && resource === "objective") return ["objective", "cancel", ...rest];
  if (action === "pause" && resource === "objective") return ["objective", "pause", ...rest];
  if (action === "resume" && resource === "objective") return ["objective", "resume", ...rest];

  if (action === "activate" || action === "deactivate") {
    if (resource === "context-set" || resource === "permission-set") {
      const [setName, ...options] = rest;
      const tag = takeOption(options, "tag");
      const provider = takeOption(tag.rest, "provider");
      if (setName !== undefined && tag.value !== undefined && provider.value !== undefined) {
        return [
          "tag",
          "context-set" === resource ? "context" : "permission",
          action,
          tag.value,
          setName,
          provider.value,
          ...provider.rest,
        ];
      }
    }
  }

  if (action === "grant" && resource === "mailbox") {
    const [recipient, ...options] = rest;
    const sender = takeOption(options, "sender");
    const types = takeRepeatedOption(sender.rest, "type");
    return recipient === undefined || sender.value === undefined || types.values.length === 0
      ? [...args]
      : [
          "tag",
          "messaging",
          "grant",
          sender.value,
          recipient,
          "--types",
          types.values.join(","),
          ...types.rest,
        ];
  }
  if (action === "revoke" && resource === "mailbox") {
    const [recipient, ...options] = rest;
    const sender = takeOption(options, "sender");
    return recipient === undefined || sender.value === undefined
      ? [...args]
      : ["tag", "messaging", "revoke", sender.value, recipient, ...sender.rest];
  }
  if (action === "issue" && resource === "mailbox-credential") {
    return ["tag", "messaging", "credential", ...rest];
  }
  if (action === "revoke" && resource === "mailbox-credential") {
    return ["tag", "messaging", "revoke-credential", ...rest];
  }
  if (action === "prune" && resource === "mailbox") {
    return ["tag", "messaging", "prune-bodies", ...rest];
  }

  if (action === "recover" && resource === "worklet") return ["worklet", "recover", ...rest];
  if (action === "connect" && resource === "worklet") return ["worklet", "connect", ...rest];
  if (action === "enroll" && resource === "worker-host") return ["worker-host", "enroll", ...rest];
  if (action === "drain" && resource === "worker-host") return ["worker-host", "drain", ...rest];
  if (action === "resume" && resource === "worker-host") return ["worker-host", "resume", ...rest];
  if (action === "rotate" && resource === "worker-host-credential")
    return ["worker-host", "rotate-credential", ...rest];
  if (action === "revoke" && resource === "worker-host-credential")
    return ["worker-host", "revoke", ...rest];

  if (resource === "control-plane") {
    if (action === "start") return ["control-plane", ...rest];
    if (action === "connect" || action === "use" || action === "remove" || action === "status")
      return ["control-plane", action, ...rest];
  }

  return [...args];
}

const LISTABLE_RESOURCES = new Set([
  "auth-key",
  "operator-token",
  "tag",
  "role",
  "permission-set",
  "context-set",
  "worker-host",
  "worker-profile",
  "workspace",
  "task",
  "session",
]);

function canonicalStatus(value: string): string {
  return value.replaceAll("-", "_");
}

function canonicalCoordination(args: readonly string[]): string[] {
  const result = [...args];
  const index = result.indexOf("--kind");
  const kind = result[index + 1];
  if (index >= 0 && kind !== undefined) result[index + 1] = canonicalStatus(kind);
  return result;
}

function wantsYaml(args: readonly string[]): boolean {
  return args.some(
    (arg, index) => arg === "--output=yaml" || (arg === "--output" && args[index + 1] === "yaml"),
  );
}

function takeOption(
  args: readonly string[],
  name: string,
): { readonly value?: string; readonly rest: string[] } {
  const long = `--${name}`;
  const index = args.findIndex((argument) => argument === long || argument.startsWith(`${long}=`));
  if (index < 0) return { rest: [...args] };
  const inline = args[index]?.startsWith(`${long}=`)
    ? args[index]?.slice(long.length + 1)
    : undefined;
  const value = inline ?? args[index + 1];
  if (value === undefined) return { rest: [...args] };
  return {
    value,
    rest: args.filter((_, candidate) =>
      inline === undefined ? candidate !== index && candidate !== index + 1 : candidate !== index,
    ),
  };
}

function takeRepeatedOption(
  args: readonly string[],
  name: string,
): { readonly values: string[]; readonly rest: string[] } {
  const values: string[] = [];
  let rest = [...args];
  for (;;) {
    const selected = takeOption(rest, name);
    if (selected.value === undefined) return { values, rest };
    values.push(selected.value);
    rest = selected.rest;
  }
}

function renameOption(args: readonly string[], from: string, to: string): string[] {
  const prefix = `--${from}`;
  return args.map((argument) =>
    argument === prefix
      ? `--${to}`
      : argument.startsWith(`${prefix}=`)
        ? `--${to}=${argument.slice(prefix.length + 1)}`
        : argument,
  );
}

function normalizeRepeated(args: readonly string[], from: string, to: string): string[] {
  const selected = takeRepeatedOption(args, from);
  return selected.values.length === 0
    ? [...args]
    : [...selected.rest, `--${to}`, selected.values.join(",")];
}
