import { expect, it } from "vitest";
import {
  canonicalRequestPath,
  NetworkRules,
  networkCredentials,
  networkHostNames,
  networkScopeOf,
} from "./src/network-scope.js";

const scope = {
  anyOrigin: false,
  rules: [
    { origins: ["https://*.githubusercontent.com"], methods: ["GET"], credential: "", paths: [] },
    {
      origins: ["https://api.github.com", "https://pypi.org:8443"],
      methods: ["GET", "HEAD"],
      credential: "github",
      paths: ["/repos/acme"],
    },
  ],
};

it("matches origins, wildcards, methods, and path prefixes as the egress proxy does", () => {
  const rules = new NetworkRules(scope);
  const allows = (method: string, url: string) => rules.allows(method, new URL(url));
  expect(allows("GET", "https://raw.githubusercontent.com/x")).toBe(true);
  expect(allows("GET", "https://a.b.githubusercontent.com/x")).toBe(true);
  expect(allows("GET", "https://githubusercontent.com/x")).toBe(false);
  expect(allows("GET", "https://evilgithubusercontent.com/x")).toBe(false);
  expect(allows("POST", "https://raw.githubusercontent.com/x")).toBe(false);
  expect(allows("GET", "https://api.github.com/repos/acme")).toBe(true);
  expect(allows("get", "https://API.github.com/repos/acme/app?x=1")).toBe(true);
  expect(allows("GET", "https://api.github.com/repos/acmex")).toBe(false);
  expect(allows("GET", "https://api.github.com/user")).toBe(false);
  expect(allows("GET", "https://pypi.org/repos/acme")).toBe(false);
  expect(allows("GET", "https://pypi.org:8443/repos/acme")).toBe(true);
  expect(allows("GET", "http://api.github.com/repos/acme")).toBe(false);
  expect(
    new NetworkRules({ anyOrigin: true, rules: [] }).allows("DELETE", new URL("http://x.test/")),
  ).toBe(true);
  expect(canonicalRequestPath("/a/%2E%2e/b")).toBe(false);
  expect(networkHostNames(scope)).toEqual([
    "*.githubusercontent.com",
    "api.github.com",
    "pypi.org",
  ]);
  expect(networkCredentials(scope)).toEqual(["github"]);
});

it("reads a Task's scope only while it admits web:fetch", () => {
  const task = (actions: string[]) => ({
    allowedActions: actions,
    policySnapshot: { runtimeAuthority: { network: scope } },
  });
  expect(networkScopeOf(task(["web:fetch"]))).toBe(scope);
  expect(networkScopeOf(task(["files:read"]))).toBeUndefined();
});
