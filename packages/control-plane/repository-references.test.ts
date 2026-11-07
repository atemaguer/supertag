import { expect, it } from "vitest";
import {
  repositoryReferences,
  unambiguousRepositoryReference,
} from "./src/repository-references.js";

it("finds owner/repo references but not paths", () => {
  expect(repositoryReferences("In atemaguer/supertag, why does deploy fail?")).toEqual([
    "atemaguer/supertag",
  ]);
  expect(repositoryReferences("Add a .gitignore that ignores __pycache__/. Thanks")).toEqual([]);
  expect(repositoryReferences("see ./src and ../lib")).toEqual([]);
  expect(repositoryReferences("open `acme/api` and socket/socket.io")).toEqual([
    "acme/api",
    "socket/socket.io",
  ]);
  expect(repositoryReferences("look at src/lib/index.ts")).toEqual([]);
});

it("treats only dotless repository parts as unambiguous", () => {
  expect(unambiguousRepositoryReference("atemaguer/supertag")).toBe(true);
  expect(unambiguousRepositoryReference("src/index.ts")).toBe(false);
  expect(unambiguousRepositoryReference("socket/socket.io")).toBe(false);
});
