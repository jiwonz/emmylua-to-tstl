import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateDeclarations } from "./transpile.js";

interface TestMetaDocument {
  modules?: unknown[];
  types: unknown[];
  globals?: unknown[];
}

async function createFixture(document: TestMetaDocument): Promise<string> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "emmylua-to-tstl-test-"));
  const metaPath = path.join(fixtureRoot, "fixture.meta.lua");
  const jsonPath = path.join(fixtureRoot, "fixture.json");

  await writeFile(metaPath, "---@meta\n", "utf8");
  await writeFile(jsonPath, JSON.stringify(document, null, 2), "utf8");

  return fixtureRoot;
}

function buildBaseDocument(): TestMetaDocument {
  return {
    types: [
      {
        type: "class",
        name: "Foo",
        members: [
          {
            type: "field",
            name: "quat",
            typ: "Quternion",
          },
          {
            type: "field",
            name: "frameworkThing",
            typ: "VFramework.VObject",
          },
          {
            type: "fn",
            name: "color",
            is_meth: false,
            params: [],
            returns: [{ typ: "Color" }],
          },
          {
            type: "fn",
            name: "color",
            is_meth: false,
            params: [{ name: "hex", typ: "string" }],
            returns: [{ typ: "Color" }],
          },
        ],
      },
      {
        type: "class",
        name: "Color",
        members: [],
      },
    ],
    globals: [],
  };
}

test("nonstrict keeps unresolved names and emits static overloads", async () => {
  const fixtureRoot = await createFixture(buildBaseDocument());

  try {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "nonstrict",
    });

    assert.match(result.text, /quat: Quternion;/);
    assert.match(result.text, /static color\(\): Color;/);
    assert.match(result.text, /static color\(hex: string\): Color;/);
    assert.doesNotMatch(result.text, /static color: /);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("strict fails conversion when unresolved types are present", async () => {
  const fixtureRoot = await createFixture(buildBaseDocument());

  try {
    await assert.rejects(
      () =>
        generateDeclarations({
          sourcePath: fixtureRoot,
          jsonPath: undefined,
          outPath: undefined,
          unresolvedTypeMode: "strict",
        }),
      /Strict unresolved type check failed[\s\S]*Quternion/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("any mode replaces unresolved bare types with any", async () => {
  const fixtureRoot = await createFixture(buildBaseDocument());

  try {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "any",
    });

    assert.match(result.text, /quat: any;/);
    assert.ok(result.warnings.some((warning) => warning.includes("replaced with 'any'")));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("any-all mode replaces qualified unresolved types with any", async () => {
  const fixtureRoot = await createFixture(buildBaseDocument());

  try {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "any-all",
    });

    assert.match(result.text, /frameworkThing: any;/);
    assert.ok(result.warnings.some((warning) => warning.includes("any-all")));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("alias-any mode preserves unresolved name and emits fallback alias", async () => {
  const fixtureRoot = await createFixture(buildBaseDocument());

  try {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "alias-any",
    });

    assert.match(result.text, /quat: Quternion;/);
    assert.match(result.text, /declare type Quternion = any;/);
    assert.ok(result.warnings.some((warning) => warning.includes("declare type Quternion = any")));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
