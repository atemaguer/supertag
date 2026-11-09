#!/usr/bin/env node
/**
 * A protoc plugin that writes one JSON Schema per manifest kind, and `manifest.schema.json`
 * matching any of them, from the messages that carry `(supertag.operator.v1.manifest)`. The
 * manifest form and its options are defined in spec/proto/supertag/operator/v1/options.proto.
 */
import { readFileSync, writeSync } from "node:fs";
import { create, createFileRegistry, fromBinary, getOption, toBinary } from "@bufbuild/protobuf";
import {
  CodeGeneratorRequestSchema,
  CodeGeneratorResponse_Feature,
  CodeGeneratorResponseSchema,
  FileDescriptorSetSchema,
} from "@bufbuild/protobuf/wkt";

const PACKAGE = "supertag.operator.v1";
const API_VERSION = "supertag/v1";
const SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const ID_BASE = "https://raw.githubusercontent.com/atemaguer/supertag/main/spec/manifests/";

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
const MANIFEST = option("manifest");
const REQUIREMENTS = option("manifest_requirements");
const FIELD = option("manifest_field");
const ONEOF = option("manifest_oneof");
const VALUE = option("manifest_value");

const comments = new Map();
for (const file of files) {
  const locations = new Map(
    (file.sourceCodeInfo?.location ?? []).map((location) => [
      location.path.join("."),
      location.leadingComments,
    ]),
  );
  const note = (key, path) => {
    const text = locations.get(path.join("."));
    if (text) comments.set(key, text);
  };
  const enums = (list, prefix, path) => {
    for (const [index, item] of list.entries()) {
      const name = `${prefix}.${item.name}`;
      note(name, [...path, index]);
      for (const [valueIndex, value] of item.value.entries())
        note(`${name}.${value.name}`, [...path, index, 2, valueIndex]);
    }
  };
  const messages = (list, prefix, path) => {
    for (const [index, item] of list.entries()) {
      const name = `${prefix}.${item.name}`;
      const at = [...path, index];
      note(name, at);
      for (const [fieldIndex, field] of item.field.entries())
        note(`${name}.${field.name}`, [...at, 2, fieldIndex]);
      for (const [oneofIndex, oneof] of item.oneofDecl.entries())
        note(`${name}.${oneof.name}`, [...at, 8, oneofIndex]);
      messages(item.nestedType, name, [...at, 3]);
      enums(item.enumType, name, [...at, 4]);
    }
  };
  messages(file.messageType, file.package, [4]);
  enums(file.enumType, file.package, [5]);
}

/** A comment as one description: paragraphs joined, lists and tables kept line by line. */
function describe(key) {
  const text = comments.get(key);
  if (text === undefined) return {};
  const paragraphs = text
    .split("\n")
    .map((line) => line.replace(/^ /u, "").trimEnd())
    .join("\n")
    .trim()
    .split(/\n{2,}/u)
    .map((paragraph) =>
      /^(?:- |\|)/mu.test(paragraph) ? paragraph : paragraph.replaceAll("\n", " "),
    );
  return { description: paragraphs.join("\n\n") };
}

function fieldRules(field) {
  return getOption(field, FIELD);
}

const INTEGER_SCALARS = new Set([3, 4, 5, 6, 7, 13, 15, 16, 17, 18]);

function scalarSchema(field, rules) {
  const scalar = field.scalar;
  if (scalar === 9 || scalar === 12)
    return {
      type: "string",
      ...(rules.pattern === "" ? {} : { pattern: rules.pattern }),
      ...(rules.minLength === undefined ? {} : { minLength: rules.minLength }),
      ...(rules.maxLength === undefined ? {} : { maxLength: rules.maxLength }),
    };
  if (scalar === 8) return { type: "boolean" };
  const numeric = {
    type: INTEGER_SCALARS.has(scalar) ? "integer" : "number",
    ...(rules.minimum === undefined ? {} : { minimum: Number(rules.minimum) }),
    ...(rules.maximum === undefined ? {} : { maximum: Number(rules.maximum) }),
  };
  return numeric;
}

function enumSchema(enumeration) {
  const values = enumeration.values
    .map((value) => getOption(value, VALUE))
    .filter((value) => value !== "");
  if (values.length === 0)
    throw new Error(`${enumeration.typeName} is used in a manifest but has no manifest_value`);
  return { enum: values };
}

class Generator {
  defs = new Map();

  item(field, rules) {
    if (field.enum !== undefined && (field.fieldKind === "enum" || field.listKind === "enum"))
      return enumSchema(field.enum);
    if (field.message !== undefined) return this.reference(field.message);
    return scalarSchema(field, rules);
  }

  field(field) {
    const rules = fieldRules(field);
    const about = describe(`${field.parent.typeName}.${field.name}`);
    if (field.fieldKind === "map") {
      const value =
        field.mapKind === "message"
          ? this.reference(field.message)
          : field.mapKind === "enum"
            ? enumSchema(field.enum)
            : scalarSchema(field, rules);
      return { ...about, type: "object", additionalProperties: value };
    }
    if (field.fieldKind === "list") {
      const item = this.item(field, rules);
      const list = {
        type: "array",
        items: item,
        ...(rules.minItems === undefined ? {} : { minItems: rules.minItems }),
        ...(rules.maxItems === undefined ? {} : { maxItems: rules.maxItems }),
      };
      return rules.acceptsSingle ? { ...about, anyOf: [item, list] } : { ...about, ...list };
    }
    return { ...about, ...this.item(field, rules) };
  }

  reference(message) {
    switch (message.typeName) {
      case "google.protobuf.Struct":
        return { type: "object" };
      case "google.protobuf.Value":
        return {};
      case "google.protobuf.ListValue":
        return { type: "array" };
      case "google.protobuf.Timestamp":
        return { type: "string", minLength: 1, description: "An RFC 3339 timestamp." };
    }
    if (!this.defs.has(message.name)) {
      this.defs.set(message.name, undefined);
      this.defs.set(message.name, { ...describe(message.typeName), ...this.message(message) });
    }
    return { $ref: `#/$defs/${message.name}` };
  }

  /** Properties, required names, and whole-object rules of a message, before any union. */
  parts(message) {
    const properties = {};
    const required = [];
    const rules = [];
    const unions = [];
    for (const member of message.members) {
      if (member.kind === "oneof") {
        const choice = getOption(member, ONEOF);
        if (choice.discriminator !== "") {
          unions.push({ oneof: member, discriminator: choice.discriminator });
          continue;
        }
        if (choice.field !== "") {
          properties[choice.field] = {
            ...describe(`${message.typeName}.${member.name}`),
            oneOf: member.fields.map((field) => this.field(field)),
          };
          if (choice.required) required.push(choice.field);
          continue;
        }
        const names = member.fields.map((field) => field.jsonName);
        for (const field of member.fields) properties[field.jsonName] = this.field(field);
        if (choice.required) rules.push({ oneOf: names.map((name) => ({ required: [name] })) });
        else
          rules.push({
            not: {
              anyOf: names.flatMap((name, index) =>
                names.slice(index + 1).map((other) => ({ required: [name, other] })),
              ),
            },
          });
        continue;
      }
      const fieldOptions = fieldRules(member);
      if (fieldOptions.outputOnly) continue;
      properties[member.jsonName] = this.field(member);
      if (fieldOptions.required) required.push(member.jsonName);
    }
    for (const requirement of getOption(message, REQUIREMENTS)) rules.push(condition(requirement));
    if (unions.length > 1)
      throw new Error(`${message.typeName} has more than one discriminated oneof`);
    return { properties, required, rules, union: unions[0] };
  }

  message(message) {
    const { properties, required, rules, union } = this.parts(message);
    if (union === undefined) return object(properties, required, rules);
    return {
      oneOf: union.oneof.fields.map((field) => {
        if (field.message === undefined)
          throw new Error(`${message.typeName}.${field.name} must be a message`);
        const variant = this.parts(field.message);
        if (variant.union !== undefined)
          throw new Error(`${field.message.typeName} nests a discriminated oneof`);
        return {
          ...describe(`${message.typeName}.${field.name}`),
          ...object(
            {
              [union.discriminator]: { const: field.jsonName },
              ...variant.properties,
              ...properties,
            },
            [union.discriminator, ...variant.required, ...required],
            [...variant.rules, ...rules],
          ),
        };
      }),
    };
  }
}

function object(properties, required, rules) {
  return {
    type: "object",
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required }),
    properties,
    ...(rules.length === 0 ? {} : { allOf: rules }),
  };
}

/** Requires each dotted path, nesting `required` through the objects on the way. */
function requiring(paths) {
  const schema = {};
  for (const path of paths) {
    let at = schema;
    for (const name of path.split(".")) {
      at.required = [...new Set([...(at.required ?? []), name])];
      at.properties ??= {};
      at.properties[name] ??= {};
      at = at.properties[name];
    }
  }
  return prune(schema);
}

function prune(schema) {
  if (schema.properties === undefined) return schema;
  const properties = Object.fromEntries(
    Object.entries(schema.properties)
      .map(([name, child]) => [name, prune(child)])
      .filter(([, child]) => Object.keys(child).length > 0),
  );
  const { properties: _, ...rest } = schema;
  return Object.keys(properties).length === 0 ? rest : { ...rest, properties };
}

function condition(requirement) {
  const names = requirement.path.split(".");
  let test = { const: requirement.equals };
  for (const name of names.toReversed()) test = { required: [name], properties: { [name]: test } };
  const rule = { if: test };
  // biome-ignore lint/suspicious/noThenProperty: `then` is a JSON Schema keyword here.
  if (requirement.required.length > 0) rule["then"] = requiring(requirement.required);
  if (requirement.otherwiseRequired.length > 0)
    rule["else"] = requiring(requirement.otherwiseRequired);
  return rule;
}

function nameSchema(rules) {
  return {
    description: "The resource's name, unique within its kind.",
    type: "string",
    ...(rules?.pattern ? { pattern: rules.pattern } : {}),
    minLength: rules?.minLength ?? 1,
    ...(rules?.maxLength === undefined ? {} : { maxLength: rules.maxLength }),
  };
}

function fileName(kind) {
  return `${kind.replace(/(?<=[a-z0-9])(?=[A-Z])/gu, "-").toLowerCase()}.schema.json`;
}

const manifests = [];
for (const file of registry.files) {
  if (file.proto.package !== PACKAGE) continue;
  for (const message of file.messages) {
    const manifest = getOption(message, MANIFEST);
    if (manifest.kind === "") continue;
    const generator = new Generator();
    const spec = generator.reference(message);
    const schema = {
      $schema: SCHEMA,
      $id: `${ID_BASE}${fileName(manifest.kind)}`,
      title: `SuperTag ${manifest.kind} manifest`,
      description: `A ${manifest.kind} manifest, as supertag apply -f reads it. Its spec is ${message.typeName} in ${file.proto.name}; this file is generated from it.`,
      type: "object",
      additionalProperties: false,
      required: ["apiVersion", "kind", "metadata", ...(manifest.specOptional ? [] : ["spec"])],
      properties: {
        apiVersion: { const: API_VERSION },
        kind: { const: manifest.kind },
        metadata: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { name: nameSchema(manifest.name) },
        },
        spec: spec,
      },
      $defs: Object.fromEntries(generator.defs),
    };
    manifests.push({ kind: manifest.kind, name: fileName(manifest.kind), schema });
  }
}
manifests.sort((left, right) => left.name.localeCompare(right.name));

const output = [
  ...manifests.map(({ name, schema }) => ({ name, content: schema })),
  {
    name: "manifest.schema.json",
    content: {
      $schema: SCHEMA,
      $id: `${ID_BASE}manifest.schema.json`,
      title: "SuperTag manifest",
      description: `One manifest of any kind that supertag apply -f reads: ${manifests
        .map(({ kind }) => kind)
        .join(", ")}. Generated from the operator API protos; do not edit.`,
      oneOf: manifests.map(({ name }) => ({ $ref: name })),
    },
  },
];

const response = create(CodeGeneratorResponseSchema, {
  supportedFeatures: BigInt(CodeGeneratorResponse_Feature.PROTO3_OPTIONAL),
  file: output.map(({ name, content }) => ({
    name,
    content: `${JSON.stringify(content, null, 2)}\n`,
  })),
});
writeSync(1, toBinary(CodeGeneratorResponseSchema, response));
