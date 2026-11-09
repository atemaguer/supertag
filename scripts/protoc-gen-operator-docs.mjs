#!/usr/bin/env node
/**
 * A protoc plugin that writes the operator API reference under docs/reference/operator-api/
 * from the `supertag.operator.v1` protos and their comments: one page per service, a page of
 * shared messages and options, and an index of every RPC with the options that guard it.
 */
import { readFileSync, writeSync } from "node:fs";
import { basename } from "node:path";
import { create, createFileRegistry, fromBinary, getOption, toBinary } from "@bufbuild/protobuf";
import {
  CodeGeneratorRequestSchema,
  CodeGeneratorResponse_Feature,
  CodeGeneratorResponseSchema,
  FileDescriptorSetSchema,
  MethodOptions_IdempotencyLevel,
} from "@bufbuild/protobuf/wkt";

const PACKAGE = "supertag.operator.v1";
const PROTO_DIRECTORY = "../../../spec/proto/supertag/operator/v1";
const GUIDE = "../control-plane-api.md";
const SHARED = "shared.md";
const CONVENTIONS = "common.proto";

const request = fromBinary(CodeGeneratorRequestSchema, readFileSync(0));
const files = request.sourceFileDescriptors.length
  ? [
      ...request.protoFile.filter(
        (file) => !request.sourceFileDescriptors.some((source) => source.name === file.name),
      ),
      ...request.sourceFileDescriptors,
    ]
  : request.protoFile;
const registry = createFileRegistry(create(FileDescriptorSetSchema, { file: files }));
const option = (name) => {
  const extension = registry.getExtension(`${PACKAGE}.${name}`);
  if (extension === undefined) throw new Error(`Missing option ${PACKAGE}.${name}`);
  return extension;
};
const ACTION = option("action");
const AUDIT_ACTION = option("audit_action");
const REQUIRES_ADMIN_TOKEN = option("requires_admin_token");
const ALLOW_ANONYMOUS = option("allow_anonymous");
const ALLOW_SCOPED_CREDENTIAL = option("allow_scoped_credential");
const REQUIRES_AUTH_KEY = option("requires_auth_key");
const ALLOW_WORKER_HOST_CREDENTIAL = option("allow_worker_host_credential");
const METHOD_OPTIONS = [
  ACTION,
  AUDIT_ACTION,
  REQUIRES_ADMIN_TOKEN,
  ALLOW_ANONYMOUS,
  ALLOW_SCOPED_CREDENTIAL,
  REQUIRES_AUTH_KEY,
  ALLOW_WORKER_HOST_CREDENTIAL,
];
for (const file of registry.files)
  for (const extension of file.extensions)
    if (
      extension.extendee.typeName === "google.protobuf.MethodOptions" &&
      extension.typeName.startsWith(`${PACKAGE}.`) &&
      !METHOD_OPTIONS.includes(extension)
    )
      throw new Error(`Document ${extension.typeName} in scripts/protoc-gen-operator-docs.mjs`);

const operatorFiles = [...registry.files]
  .filter((file) => file.proto.package === PACKAGE)
  .sort((left, right) => left.name.localeCompare(right.name));

// --- Comments -------------------------------------------------------------------------------

function locationsOf(file) {
  return new Map(
    (file.proto.sourceCodeInfo?.location ?? []).map((location) => [
      location.path.join("."),
      location,
    ]),
  );
}
const locationsByFile = new Map(operatorFiles.map((file) => [file, locationsOf(file)]));

function fileOf(descriptor) {
  let at = descriptor;
  while (at.kind !== "file") at = at.file ?? at.parent;
  return at;
}

/** The element's source path, as SourceCodeInfo records it. */
function pathOf(descriptor) {
  switch (descriptor.kind) {
    case "service":
      return [6, descriptor.file.services.indexOf(descriptor)];
    case "rpc":
      return [...pathOf(descriptor.parent), 2, descriptor.parent.methods.indexOf(descriptor)];
    case "message":
      return descriptor.parent === undefined
        ? [4, descriptor.file.messages.indexOf(descriptor)]
        : [...pathOf(descriptor.parent), 3, descriptor.parent.nestedMessages.indexOf(descriptor)];
    case "enum":
      return descriptor.parent === undefined
        ? [5, descriptor.file.enums.indexOf(descriptor)]
        : [...pathOf(descriptor.parent), 4, descriptor.parent.nestedEnums.indexOf(descriptor)];
    case "enum_value":
      return [...pathOf(descriptor.parent), 2, descriptor.parent.values.indexOf(descriptor)];
    case "field":
      return [
        ...pathOf(descriptor.parent),
        2,
        descriptor.parent.proto.field.indexOf(descriptor.proto),
      ];
    case "oneof":
      return [
        ...pathOf(descriptor.parent),
        8,
        descriptor.parent.proto.oneofDecl.indexOf(descriptor.proto),
      ];
    case "extension":
      return [7, descriptor.file.extensions.indexOf(descriptor)];
    default:
      throw new Error(`No source path for ${descriptor.kind}`);
  }
}

function clean(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/^ /u, "").trimEnd())
    .join("\n")
    .trim();
}

function comment(descriptor) {
  const location = locationsByFile.get(fileOf(descriptor))?.get(pathOf(descriptor).join("."));
  const text = location?.leadingComments || location?.trailingComments || "";
  return clean(text);
}

/** The comments before the file's first declaration: what the whole file is about. */
function fileOverview(file) {
  const first = [...(file.proto.sourceCodeInfo?.location ?? [])]
    .filter((location) => location.path.length === 2 && [4, 5, 6, 7].includes(location.path[0]))
    .sort((left, right) => left.span[0] - right.span[0])[0];
  return (first?.leadingDetachedComments ?? []).map(clean).filter(Boolean).join("\n\n");
}

/** A comment as one Markdown table cell. */
function cell(text) {
  return text
    .split(/\n{2,}/u)
    .map((paragraph) => {
      const items = [];
      for (const line of paragraph.split("\n")) {
        if (/^(?:- |\d+\. |\|)/u.test(line) || items.length === 0) items.push(line);
        else items[items.length - 1] += ` ${line.trim()}`;
      }
      return items.join("<br>");
    })
    .join("<br><br>")
    .replaceAll("|", "\\|");
}

function firstSentence(text) {
  const paragraph = text.split(/\n{2,}/u)[0].replaceAll("\n", " ");
  const end = paragraph.search(/\.(?=\s)/u);
  return end < 0 ? paragraph : paragraph.slice(0, end + 1);
}

// --- Pages and anchors ----------------------------------------------------------------------

function pageOf(file) {
  return file.services.length ? `${basename(file.proto.name, ".proto")}.md` : SHARED;
}

/** The anchor GitHub gives a heading, as scripts/docs-links.mjs checks it. */
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/gu, "-");
}

function localName(descriptor) {
  return descriptor.typeName.slice(PACKAGE.length + 1);
}

function link(descriptor, from) {
  if (!descriptor.typeName.startsWith(`${PACKAGE}.`)) return `\`${descriptor.typeName}\``;
  const page = pageOf(fileOf(descriptor));
  const target = `${page === from ? "" : page}#${slug(localName(descriptor))}`;
  return `[\`${localName(descriptor)}\`](${target})`;
}

const SCALARS = {
  1: "double",
  2: "float",
  3: "int64",
  4: "uint64",
  5: "int32",
  6: "fixed64",
  7: "fixed32",
  8: "bool",
  9: "string",
  12: "bytes",
  13: "uint32",
  15: "sfixed32",
  16: "sfixed64",
  17: "sint32",
  18: "sint64",
};

function valueType(field, kind, from) {
  if (kind === "message") return link(field.message, from);
  if (kind === "enum") return link(field.enum, from);
  return `\`${SCALARS[field.scalar]}\``;
}

function fieldType(field, from) {
  switch (field.fieldKind) {
    case "list":
      return `repeated ${valueType(field, field.listKind, from)}`;
    case "map":
      return `map of \`${SCALARS[field.mapKey]}\` to ${valueType(field, field.mapKind, from)}`;
    default: {
      const type = valueType(field, field.fieldKind, from);
      return field.proto.proto3Optional ? `optional ${type}` : type;
    }
  }
}

// --- Rendering ------------------------------------------------------------------------------

function nestedMessages(messages) {
  return messages.flatMap((message) => [message, ...nestedMessages(message.nestedMessages)]);
}
function nestedEnums(messages) {
  return messages.flatMap((message) => [
    ...message.nestedEnums,
    ...nestedEnums(message.nestedMessages),
  ]);
}

function rpcFacts(method) {
  return {
    action: getOption(method, ACTION),
    audit: getOption(method, AUDIT_ACTION),
    readOnly: method.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS,
    adminOnly: getOption(method, REQUIRES_ADMIN_TOKEN),
    anonymous: getOption(method, ALLOW_ANONYMOUS),
    scoped: getOption(method, ALLOW_SCOPED_CREDENTIAL),
    authKey: getOption(method, REQUIRES_AUTH_KEY),
    workerHost: getOption(method, ALLOW_WORKER_HOST_CREDENTIAL),
    streams: method.methodKind === "server_streaming",
  };
}

function callers(facts) {
  if (facts.authKey) return "An Auth Key, in place of an operator credential";
  const accepted = facts.adminOnly ? ["the admin token"] : ["the admin token", "Operator Tokens"];
  if (facts.scoped) accepted.push("scoped coordination credentials");
  if (facts.workerHost) accepted.push("the Worker Host's own credential");
  const list =
    accepted.length === 1
      ? accepted[0]
      : `${accepted.slice(0, -1).join(", ")}${accepted.length > 2 ? "," : ""} and ${accepted.at(-1)}`;
  const text = `${list.charAt(0).toUpperCase()}${list.slice(1)}${facts.adminOnly ? " only" : ""}`;
  return facts.anonymous ? `Anyone; ${list}, when sent, are checked` : text;
}

function records(facts) {
  if (facts.audit) return `\`${facts.audit}\``;
  return facts.readOnly ? "Nothing; reads only" : "Nothing";
}

function renderRpc(service, method, page) {
  const facts = rpcFacts(method);
  const lines = [
    `### ${method.name}`,
    "",
    "| | |",
    "| --- | --- |",
    `| Procedure | \`/${service.typeName}/${method.name}\` |`,
    `| Request | ${link(method.input, page)} |`,
    `| Response | ${facts.streams ? "A server stream of " : ""}${link(method.output, page)} |`,
    `| Action | \`${facts.action}\` |`,
    `| Callers | ${callers(facts)} |`,
    `| Audit log | ${records(facts)} |`,
  ];
  const text = comment(method);
  if (text) lines.push("", text);
  return lines.join("\n");
}

function renderMessage(message, page) {
  const lines = [`### ${localName(message)}`];
  const text = comment(message);
  if (text) lines.push("", text);
  if (message.fields.length) {
    lines.push("", "| Field | JSON | Type | Description |", "| --- | --- | --- | --- |");
    for (const field of message.fields) {
      const oneof = field.oneof === undefined ? "" : `One of \`${field.oneof.name}\`. `;
      lines.push(
        `| \`${field.name}\` | \`${field.jsonName}\` | ${fieldType(field, page)} | ${cell(oneof + comment(field))} |`,
      );
    }
  } else lines.push("", "No fields.");
  for (const oneof of message.oneofs) {
    const members = oneof.fields.map((field) => `\`${field.name}\``).join(", ");
    const about = comment(oneof);
    lines.push("", `Oneof \`${oneof.name}\`: ${members}.${about ? ` ${about}` : ""}`);
  }
  return lines.join("\n");
}

function renderEnum(enumeration) {
  const lines = [`### ${localName(enumeration)}`];
  const text = comment(enumeration);
  if (text) lines.push("", text);
  lines.push("", "| Value | Description |", "| --- | --- |");
  for (const value of enumeration.values)
    lines.push(`| \`${value.name}\` | ${cell(comment(value))} |`);
  return lines.join("\n");
}

function renderExtensions(extensions, page) {
  const lines = ["| Option | Applies to | Type | Description |", "| --- | --- | --- | --- |"];
  for (const extension of extensions)
    lines.push(
      `| \`(${extension.typeName})\` | \`${extension.extendee.typeName}\` | ${fieldType(extension, page)} | ${cell(comment(extension))} |`,
    );
  return lines.join("\n");
}

const GENERATED = `<!-- Generated from ${PROTO_DIRECTORY.replace(/^(\.\.\/)+/u, "")} by scripts/protoc-gen-operator-docs.mjs. Edit the proto comments, not this file. -->`;

function definitions(sourceFiles, page) {
  const messages = sourceFiles.flatMap((file) => nestedMessages(file.messages));
  const enums = sourceFiles.flatMap((file) => [...file.enums, ...nestedEnums(file.messages)]);
  const sections = [];
  if (messages.length)
    sections.push(
      ["## Messages", ...messages.map((message) => renderMessage(message, page))].join("\n\n"),
    );
  if (enums.length) sections.push(["## Enums", ...enums.map(renderEnum)].join("\n\n"));
  return sections;
}

function checkAnchors(name, content) {
  const seen = new Set();
  let fenced = false;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/u.test(line)) fenced = !fenced;
    const heading = !fenced && line.match(/^#{1,6}\s+(.+?)\s*$/u);
    if (!heading) continue;
    const anchor = slug(heading[1]);
    if (seen.has(anchor)) throw new Error(`${name}: two headings share the anchor #${anchor}`);
    seen.add(anchor);
  }
}

function sourceLink(file) {
  return `[\`${basename(file.proto.name)}\`](${PROTO_DIRECTORY}/${basename(file.proto.name)})`;
}

const pages = [];
const services = [];
for (const file of operatorFiles.filter((candidate) => candidate.services.length)) {
  const page = pageOf(file);
  if (file.services.length !== 1) throw new Error(`${file.name} must define one service`);
  const [service] = file.services;
  services.push({ service, page });
  const overview = fileOverview(file);
  const sections = [
    `# ${service.name}`,
    GENERATED,
    [
      `\`${service.typeName}\` in ${sourceLink(file)}. How to call an RPC, authenticate, and`,
      `read its errors is in the [Control Plane API Server](${GUIDE}) guide; the conventions every`,
      `RPC follows are in [Shared messages and options](${SHARED}#conventions).`,
    ].join("\n"),
    ...(overview ? [overview] : []),
    ...(comment(service) ? [comment(service)] : []),
    ["## RPCs", ...service.methods.map((method) => renderRpc(service, method, page))].join("\n\n"),
    ...definitions([file], page),
  ];
  pages.push({ name: page, content: sections.join("\n\n") });
}

const sharedFiles = operatorFiles.filter((file) => !file.services.length);
const conventions = sharedFiles.find((file) => basename(file.proto.name) === CONVENTIONS);
if (conventions === undefined || !fileOverview(conventions))
  throw new Error(`${CONVENTIONS} must open with the package conventions`);
const extensions = sharedFiles.flatMap((file) => file.extensions);
const sharedSections = [
  "# Shared messages and options",
  GENERATED,
  [
    "The messages, enums, and options that several operator services share, from",
    `${sharedFiles.map(sourceLink).join(", ")}.`,
  ].join("\n"),
  ...sharedFiles
    .filter((file) => file !== conventions)
    .map(fileOverview)
    .filter(Boolean),
  "## Conventions",
  fileOverview(conventions),
  ...(extensions.length ? [["## Options", renderExtensions(extensions, SHARED)].join("\n\n")] : []),
  ...definitions(sharedFiles, SHARED),
];
pages.push({ name: SHARED, content: sharedSections.join("\n\n") });

const index = [
  "# Operator API reference",
  GENERATED,
  [
    `The \`${PACKAGE}\` services, generated from the protos in`,
    `[\`spec/proto/supertag/operator/v1/\`](${PROTO_DIRECTORY}/). The`,
    `[Control Plane API Server](${GUIDE}) guide explains how to call them: the endpoint,`,
    `authentication, errors, and server streams. [Shared messages and options](${SHARED}) holds`,
    "the conventions every RPC follows and the messages several services use.",
  ].join("\n"),
  "## Services",
  [
    "| Service | Serves |",
    "| --- | --- |",
    ...services.map(
      ({ service, page }) =>
        `| [\`${service.name}\`](${page}) | ${cell(firstSentence(comment(service)))} |`,
    ),
  ].join("\n"),
  "## RPCs",
  [
    "Every RPC needs its action. The admin token and Operator Tokens carry every action. The",
    "audit log records an entry for each call to an RPC that names an audit action.",
  ].join("\n"),
  [
    "| RPC | Action | Callers | Audit log | Summary |",
    "| --- | --- | --- | --- | --- |",
    ...services.flatMap(({ service, page }) =>
      service.methods.map((method) => {
        const facts = rpcFacts(method);
        const name = `[\`${service.name}.${method.name}\`](${page}#${slug(method.name)})`;
        return `| ${name}${facts.streams ? " (stream)" : ""} | \`${facts.action}\` | ${callers(facts)} | ${records(facts)} | ${cell(firstSentence(comment(method)))} |`;
      }),
    ),
  ].join("\n"),
];
pages.push({ name: "README.md", content: index.join("\n\n") });

for (const { name, content } of pages) checkAnchors(name, content);

const response = create(CodeGeneratorResponseSchema, {
  supportedFeatures: BigInt(CodeGeneratorResponse_Feature.PROTO3_OPTIONAL),
  file: pages.map(({ name, content }) => ({ name, content: `${content}\n` })),
});
writeSync(1, toBinary(CodeGeneratorResponseSchema, response));
