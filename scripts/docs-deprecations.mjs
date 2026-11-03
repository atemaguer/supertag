// Keep these checks about removed user interfaces, not still-supported SDK contracts.
// In particular S3ArtifactStore and manager-only harness tools are current interfaces.
const removedInstructions = [
  [
    /\bsupertag\s+(?:tag (?:permission|context|add|remove)|get presences)\b/gu,
    "use resource manifests and Tag locations",
  ],
  [/\bPairing token matches\b/giu, "check the enrolled Worker Host credential"],
  [/\bmain manager\b/giu, "say root harness actor, as harness prompts do"],
  [
    /\bsupertag\s+(?:get|list|describe|delete|watch)\s+(?:tags|objectives|tasks|teams|roles|surfaces|sessions|volumes|workspaces|workstreams|artifacts|approvals|messages|permission-sets|permissionsets?|context-sets|contextsets?|worker-hosts|workerhosts?|worker-profiles|workerprofiles?|mailbox-grants|mailboxgrants?|auth-keys|authkeys?)\b/gu,
    "use the singular resource name that supertag --help lists",
  ],
  [
    /\bsupertag\s+(?:create tag|tag create)[^\n`]*--worker-profile\b/gu,
    "bind a Worker Host; select execution profiles on Tasks",
  ],
];

export function deprecatedDocProblems(name, text) {
  const problems = [];
  for (const [pattern, replacement] of removedInstructions) {
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(`${name}:${line}: obsolete instruction; ${replacement}`);
    }
  }
  return problems;
}

/** Extract endpoint-list rows; API references align verbs with variable whitespace. */
export function documentedApiEndpoints(text) {
  return text.split("\n").flatMap((line, index) => {
    const match = line.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/v1\/\S+)\s*$/u);
    return match ? [{ line: index + 1, method: match[1], path: match[2] }] : [];
  });
}
