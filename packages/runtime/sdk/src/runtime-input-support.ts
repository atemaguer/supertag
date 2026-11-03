import type { TagContextPlan } from "@supertag/core";
import type { ContextTypeSupport } from "./execution-capabilities.js";
import type { ContextOutputSupport, RuntimeInput, RuntimeInputProvider } from "./index.js";

const contextKinds: readonly RuntimeInput["kind"][] = [
  "instruction",
  "skill",
  "history",
  "resource",
];
const inputKinds: readonly RuntimeInput["kind"][] = [
  ...contextKinds,
  "tool",
  "workspace",
  "secret",
  "sessionState",
  "harness-specific",
];

/** A declaration bounds all possible outputs; it cannot create another advertised contract. */
export function validateContextOutputs(provider: RuntimeInputProvider): void {
  const seen = new Set<string>();
  for (const output of provider.contextOutputs ?? []) {
    if (
      !Array.isArray(output.inputKinds) ||
      !output.inputKinds.length ||
      new Set(output.inputKinds).size !== output.inputKinds.length ||
      output.inputKinds.some((kind) => !inputKinds.includes(kind))
    )
      throw new Error(`Runtime Input Provider ${provider.id} has invalid context output kinds`);
    if (!output.versions.length)
      throw new Error(`Runtime Input Provider ${provider.id} has no context output versions`);
    for (const version of output.versions) {
      const key = JSON.stringify([output.type, version]);
      if (
        seen.has(key) ||
        !provider.contextTypes?.some(
          (contract) => contract.type === output.type && contract.versions.includes(version),
        )
      )
        throw new Error(
          `Runtime Input Provider ${provider.id} must refine a unique advertised context contract`,
        );
      seen.add(key);
    }
  }
  for (const contract of provider.contextTypes ?? [])
    for (const version of contract.versions)
      if (!seen.has(JSON.stringify([contract.type, version])))
        throw new Error(
          `Runtime Input Provider ${provider.id} must declare a context output contract for ${contract.type}@${version}`,
        );
}

function outputFor(
  provider: RuntimeInputProvider,
  type: string,
  version: number,
): ContextOutputSupport | undefined {
  return provider.contextOutputs?.find(
    (output) => output.type === type && output.versions.includes(version),
  );
}

/** Every registered producer runs, so an alternative producer cannot hide incompatible output. */
export function supportedContextTypes(
  providers: readonly RuntimeInputProvider[],
  accepted: readonly RuntimeInput["kind"][],
): readonly ContextTypeSupport[] {
  const versionsByType = new Map<string, Set<number>>();
  for (const provider of providers)
    for (const contract of provider.contextTypes ?? []) {
      const versions = versionsByType.get(contract.type) ?? new Set<number>();
      for (const version of contract.versions) versions.add(version);
      versionsByType.set(contract.type, versions);
    }
  return [...versionsByType.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, versions]) => ({
      type,
      versions: [...versions]
        .filter((version) =>
          providers.every((provider) => {
            if (
              !provider.contextTypes?.some(
                (contract) => contract.type === type && contract.versions.includes(version),
              )
            )
              return true;
            const output = outputFor(provider, type, version);
            return output?.inputKinds.every((kind) => accepted.includes(kind)) ?? false;
          }),
        )
        .sort((left, right) => left - right),
    }))
    .filter((contract) => contract.versions.length > 0);
}

/** Output guarantees are checked against the admitted source association during resolution. */
export function assertContextOutputs(
  provider: RuntimeInputProvider,
  inputs: readonly RuntimeInput[],
  plan: TagContextPlan,
): void {
  const items = new Map(plan.sets.flatMap((set) => set.items).map((item) => [item.itemKey, item]));
  for (const input of inputs) {
    if (input.sourceItemKey === undefined) {
      // Providers outside context resolution may supply runtime policy instructions.
      if (
        contextKinds.includes(input.kind) &&
        (provider.scope === "context" ||
          provider.contextTypes?.length ||
          provider.contextOutputs?.length)
      )
        throw new Error(
          `Runtime Input Provider ${provider.id} must associate declared context outputs with sourceItemKey`,
        );
      continue;
    }
    const item = items.get(input.sourceItemKey);
    if (!item)
      throw new Error(`Runtime Input Provider ${provider.id} returned an unknown context source`);
    const output = outputFor(provider, item.type, item.version);
    if (!output?.inputKinds.includes(input.kind))
      throw new Error(
        `Runtime Input Provider ${provider.id} emitted undeclared ${input.kind} for ${item.type}@${item.version}`,
      );
  }
}
