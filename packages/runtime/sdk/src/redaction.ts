/** Internal shared policy for Worker events, durable journals, and host replies. */
const STORAGE_SUFFIX = /(?:^|[_-])(?:store|directory|dir|path|file)$/iu;
const CREDENTIAL_NAME =
  /token|secret|password|passphrase|pwd|credential|authorization|cookie|jwt|signature|api[_-]?key|access_?key|private_?key|sshkey/iu;

// Leading, doubled, and trailing underscores leave empty segments; the other segments still count.
const ENVIRONMENT_NAME = /^(?=[A-Z0-9_]*[A-Z])[A-Z0-9_]+$/u;
const ENVIRONMENT_CREDENTIAL_SEGMENT =
  /(?:^|_)(?:KEY|SK|TOKEN|SECRET|PASS|PASSWD|PASSWORD|PWD|PAT|CREDENTIALS?|AUTH|COOKIE)(?:_|$)/u;

export function isSensitiveName(name: string): boolean {
  // Storage locations describe where to find a credential, not the credential itself.
  if (STORAGE_SUFFIX.test(name)) return false;
  return (
    CREDENTIAL_NAME.test(name) ||
    (ENVIRONMENT_NAME.test(name) && ENVIRONMENT_CREDENTIAL_SEGMENT.test(name))
  );
}

/** A storage setting for a credential, such as `PASSWORD_STORE_DIR`, holds a location. */
function credentialStorageName(name: string): boolean {
  return STORAGE_SUFFIX.test(name) && CREDENTIAL_NAME.test(name.replace(STORAGE_SUFFIX, ""));
}

function pathLike(value: string): boolean {
  return /^(?:~|\.{1,2})?[\\/]|^[a-z]:[\\/]/iu.test(value.trim());
}

function sensitiveQueryName(name: string): boolean {
  // A credential-bearing container remains sensitive even with an ordinary child.
  return name.split(/[[\]]/u).some((part) => {
    const key = part.trim();
    return CREDENTIAL_NAME.test(key) || /^key$/iu.test(key);
  });
}

/** Host hints retain their confidence when callers combine them with resolved credentials. */
export type SensitiveValue = string | { readonly lowConfidence: string };

/** Ordinary words use lowercase, uppercase, or a single initial capital. */
function ordinaryWord(value: string): boolean {
  return /^(?:[a-z]+|[A-Z]+|[A-Z][a-z]+)$/u.test(value);
}

function plausibleSecret(value: string): boolean {
  return value.length >= 8 && !ordinaryWord(value);
}

/** Decode diagnostic representations, not arbitrary application data. */
function decodeDiagnostic(text: string): string {
  return text
    .replace(
      /\\(?:["\\/bfnrt]|u[\da-fA-F]{4})/gu,
      (escaped) => JSON.parse(`"${escaped}"`) as string,
    )
    .replace(/(?:%[\da-f]{2})+/giu, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        // Keep invalid UTF-8 bytes, but do not let them hide adjacent ASCII URL delimiters.
        return encoded.replace(/%([\da-f]{2})/giu, (match, hex: string) => {
          const byte = Number.parseInt(hex, 16);
          return byte < 128 ? String.fromCharCode(byte) : match;
        });
      }
    });
}

function endpointPort(candidate: string): boolean {
  const port = /^\/\/[^:/\\?#@]+:(\d+)[/\\?#]/u.exec(candidate)?.[1];
  return port !== undefined && Number(port) <= 65535;
}

function redactUrlUserinfo(text: string, collect: (value: string) => void): string {
  // Consume a whole non-whitespace run once, including candidates without credentials.
  // Retrying a failed userinfo match at every // would be quadratic.
  return text.replace(/[/\\]{2}\S*/gu, (run: string, offset: number) => {
    // Preserve ordinary UNC paths, but a user:password prefix is still userinfo.
    const unc =
      run.slice(0, 2) !== "//" && text[offset - 1] !== ":" && !/^[/\\]{2}[^:/\\?#@]*:/u.test(run);
    let changed = false;
    const redact = (candidate: string): string => {
      if (!candidate.startsWith("//")) return candidate;
      // A password prefix may have an empty username. Without a password prefix,
      // only the authority can contain userinfo. A later @ in a scoped package
      // path, query, or fragment is unrelated.
      const passwordPrefix = /^\/\/[^:/\\?#@]*:/u.test(candidate);
      const firstAt = candidate.indexOf("@", 2);
      if (firstAt === -1) return candidate;
      // Without a password prefix, @ must occur in the authority. List punctuation
      // only terminates following text; it may also be part of the username itself.
      if (!passwordPrefix && /[/\\?#"'<>]/u.test(candidate.slice(2, firstAt))) return candidate;
      const boundary = candidate
        .slice(firstAt)
        .search(passwordPrefix ? /(?<!,)(?<!\/)[/\\?#"'<>]/u : /[/\\?#"'<>,;|]/u);
      const end = boundary === -1 ? candidate.length : boundary + firstAt;
      const at = candidate.lastIndexOf("@", end);
      if (at >= end) return candidate;
      if (at === -1) return candidate;
      const value = candidate.slice(2, at);
      const colon = value.indexOf(":");
      const username = colon === -1 ? value : value.slice(0, colon);
      if ((!username && colon === -1) || /[/\\?#]/u.test(username)) return candidate;
      // Quotes and URL delimiters can occur in diagnostic passwords. A digit prefix
      // is not proof of a port when a later @ could still terminate userinfo.
      if (colon !== -1) {
        collect(value.slice(colon + 1));
        // A valid URL can also contain @ in its path. Preserve its actual password
        // for redacting detached copies, even when the diagnostic scan hides more.
        try {
          const password = new URL(`redaction:${candidate}`).password;
          if (password) collect(password);
        } catch {
          // Malformed diagnostic URLs still use the complete raw userinfo above.
        }
      }
      // Recognizable username tokens are credentials; ordinary usernames are not.
      if (/^(?:gh[pousr]_|github_pat_|glpat-|npm_|xox[baprs]-|sk-)/u.test(username))
        collect(username);
      changed = true;
      return `//[REDACTED]${candidate.slice(at)}`;
    };
    // Scan each scheme-like run once, even if it lacks ://. Keep any leading
    // digits/punctuation with the separator so embedded schemes need no delimiter.
    const parts = (unc ? run : `//${run.slice(2)}`).split(
      /((?<![a-z\d+.-])[\d+.-]*[a-z][a-z\d+.-]*:[/\\]{2}|[?&#,;|()`"'<>/={}][/\\]{2})/giu,
    );
    const output: string[] = [];
    let pending = [parts[0] ?? ""];
    let credentialPrefix = /^\/\/[^:/\\?#@]*:/u.test(pending[0] ?? "");
    let hasAt = (pending[0] ?? "").includes("@");
    let portPrefix = endpointPort(pending[0] ?? "");
    for (let index = 1; index < parts.length; index += 2) {
      const separator = parts[index] ?? "";
      const next = parts[index + 1] ?? "";
      // Do not split ,// (or another bare URL separator) inside a password. Also
      // retain an unfinished credential prefix across an apparent URL list boundary.
      if (
        credentialPrefix &&
        !portPrefix &&
        (!hasAt || (!separator.includes(":") && !/^[^:/\\?#@]*:/u.test(next)))
      ) {
        // Even when the whole run is ambiguous, collect the next URL's
        // password too, so detached copies cannot escape the environment filter.
        redact(`//${next}`);
        pending.push(separator, next);
        hasAt ||= next.includes("@");
      } else {
        output.push(redact(pending.join("")), separator.slice(0, -2));
        pending = [`//${next}`];
        credentialPrefix = /^\/\/[^:/\\?#@]*:/u.test(pending[0] ?? "");
        hasAt = next.includes("@");
        portPrefix = endpointPort(pending[0] ?? "");
      }
    }
    output.push(redact(pending.join("")));
    return changed ? output.join("") : run;
  });
}

function redactUrlCredentials(text: string, collect: (value: string) => void = () => {}): string {
  return redactUrlUserinfo(text, collect).replace(
    // Consume names even without '='. Otherwise '?' inside a failed name would
    // restart the scan at every subsequent '?', making a single run quadratic.
    /([?&#])((?:[^=&#\s"<>]| )+)(?:=([^&#\s"<>]*))?/gu,
    (match: string, separator: string, name: string, value: string | undefined) => {
      if (value === undefined || !sensitiveQueryName(name)) return match;
      collect(value);
      return `${separator}${name}=[REDACTED]`;
    },
  );
}

function namedSensitiveValues(name: string, value: string): string[] {
  // A credential storage setting such as PASSWORD_STORE_DIR names a location or a backend.
  // Paths and short plain words stay readable; a token-shaped value is still a secret.
  const values =
    isSensitiveName(name) ||
    (credentialStorageName(name) && !pathLike(value) && !/^[a-z]{1,16}$/u.test(value.trim()))
      ? [value]
      : [];
  if (/(?:^|[_-])url$/iu.test(name)) {
    let decoded = value;
    for (let round = 0; round < 3; round++) {
      const safe = redactUrlCredentials(decoded, (credential) => {
        if (credential === "[REDACTED]") return;
        // Decode the isolated password before an encoded @ can be mistaken for
        // the end of userinfo on the next pass through the entire URL.
        for (let encoding = 0; encoding < 3; encoding++) {
          values.push(credential);
          const next = decodeDiagnostic(credential);
          if (next === credential) break;
          credential = next;
        }
      });
      // Remove already collected userinfo before decoding the rest of the URL.
      // Otherwise p%40ssword would contribute the unrelated one-letter secret p.
      const next = decodeDiagnostic(safe);
      if (next === safe) break;
      decoded = next;
    }
  }
  return values;
}

export function sensitiveEnvironmentValues(
  environment: Readonly<Record<string, string | undefined>>,
): readonly SensitiveValue[] {
  return uniqueSensitiveValues(
    Object.entries(environment).flatMap(([name, value]): SensitiveValue[] => {
      // The shell's working-directory variables hold locations, not passwords.
      if (value === undefined || /^(?:OLD)?PWD$/u.test(name)) return [];
      // URL userinfo and credential query values are explicit credentials at any length.
      const url = /(?:^|[_-])url$/iu.test(name);
      return namedSensitiveValues(name, value).flatMap((secret): SensitiveValue[] => {
        if (url || plausibleSecret(secret)) return [secret];
        if (secret.length < 4 || /^(?:true|false|yes|no|\d+)$/iu.test(secret)) return [];
        return [{ lowConfidence: secret }];
      });
    }),
  );
}

export function uniqueSensitiveValues(values: readonly string[]): readonly string[];
export function uniqueSensitiveValues(values: readonly SensitiveValue[]): readonly SensitiveValue[];
export function uniqueSensitiveValues(
  values: readonly SensitiveValue[],
): readonly SensitiveValue[] {
  const unique = new Map<string, SensitiveValue>();
  for (const item of values) {
    const value = typeof item === "string" ? item : item.lowConfidence;
    if (value && (typeof item === "string" || !unique.has(value))) unique.set(value, item);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => right.length - left.length)
    .map(([, item]) => item);
}

/** The encoded forms in which a resolved credential is recognized as a substring. */
function encodedForms(value: string): string[] {
  return [
    value,
    encodeURIComponent(value.toWellFormed()),
    JSON.stringify(value).slice(1, -1),
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("base64").replace(/=+$/u, ""),
    Buffer.from(value).toString("base64url"),
  ];
}

export function redactText(
  text: string,
  sensitiveValues: readonly SensitiveValue[],
  structural = false,
): string {
  // Resolved credentials match at any length, including inside structural fields.
  const high = sensitiveValues.filter((value): value is string => typeof value === "string");
  const low = structural
    ? []
    : sensitiveValues.flatMap((value) => (typeof value === "string" ? [] : [value.lowConfidence]));
  const values = uniqueSensitiveValues(high.flatMap(encodedForms));
  const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const highPattern = values.length
    ? new RegExp(values.map(escapePattern).join("|"), "gu")
    : undefined;
  const lowValues = uniqueSensitiveValues(low);
  const redactWords = (input: string): string => {
    if (!lowValues.length) return input;
    // URI runs never receive low-confidence replacement, even inside a message.
    return input
      .split(
        /((?<![a-z\d+.-])[a-z][a-z\d+.-]*:\/\/[^\s<>"']*|(?:urn|mailto|tel|data|file):[^\s<>"']*|supertag-artifact:sha256:[a-f0-9]{64}|\/\/[^\s<>"']*|\[REDACTED\])/giu,
      )
      .map((part, index) =>
        index % 2
          ? part
          : lowValues.reduce(
              (safe, value) =>
                safe.replaceAll(
                  new RegExp(
                    `(?<!\\w)${value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?!\\w)`,
                    "giu",
                  ),
                  "[REDACTED]",
                ),
              part,
            ),
      )
      .join("");
  };
  const protectedParts = /(supertag-artifact:sha256:[a-f0-9]{64}(?![a-f0-9])|\[REDACTED\])/gu;
  const outsideProtected = (input: string, transform: (text: string) => string): string =>
    input
      .split(protectedParts)
      .map((part, index) => (index % 2 ? part : transform(part)))
      .join("");
  const protectedRedact = (input: string): string => {
    const safe = outsideProtected(input, (part) =>
      redactUrlCredentials(part).replace(/\bBasic\s+[a-z\d+/_-]+=*/giu, "Basic [REDACTED]"),
    );
    // Replace against the original matches in one pass. A short hint must never split a
    // longer known secret before that secret is masked, or alter a redaction marker.
    const highSafe = outsideProtected(safe, (part) =>
      highPattern ? part.replaceAll(highPattern, "[REDACTED]") : part,
    );
    return redactWords(highSafe);
  };
  let safe = protectedRedact(text);
  // Only normalize escaped diagnostics if doing so reveals a credential. Ordinary text keeps
  // its original representation. Multiple passes cover JSON containing a percent-encoded URL.
  let decoded = safe;
  for (let round = 0; round < 3; round++) {
    const next = decodeDiagnostic(decoded);
    if (next === decoded) break;
    decoded = next;
    const redacted = protectedRedact(decoded);
    if (redacted !== decoded) safe = decoded = redacted;
  }
  return safe;
}
