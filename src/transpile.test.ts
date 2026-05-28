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

async function withFixture<T>(document: TestMetaDocument, run: (fixtureRoot: string) => Promise<T>): Promise<T> {
  const fixtureRoot = await createFixture(document);

  try {
    return await run(fixtureRoot);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
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

test("nonstrict keeps unresolved names and emits static overloads", { concurrency: false }, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "nonstrict",
    });

    assert.ok(
      result.text.includes(`declare class Foo {
    private constructor();
    frameworkThing: VFramework.VObject;
    quat: Quternion;
    static color(): Color;
    static color(hex: string): Color;
}`),
    );
    assert.equal(result.warnings.length, 0);
  });
});

test("strict fails conversion when unresolved types are present", { concurrency: false }, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
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
  });
});

test("any mode replaces unresolved bare types with any", { concurrency: false }, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "any",
    });

    assert.ok(
      result.text.includes(`declare class Foo {
    private constructor();
    frameworkThing: VFramework.VObject;
    quat: any;
    static color(): Color;
    static color(hex: string): Color;
}`),
    );
    assert.deepEqual(result.warnings, ["Unresolved bare type 'Quternion' encountered; replaced with 'any' due to --unresolved-type any."]);
  });
});

test("any-all mode replaces qualified unresolved types with any", { concurrency: false }, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "any-all",
    });

    assert.ok(
      result.text.includes(`declare class Foo {
    private constructor();
    frameworkThing: any;
    quat: any;
    static color(): Color;
    static color(hex: string): Color;
}`),
    );
    assert.deepEqual(result.warnings, [
      "Unresolved type 'VFramework.VObject' encountered; replaced with 'any' due to --unresolved-type any-all.",
      "Unresolved type 'Quternion' encountered; replaced with 'any' due to --unresolved-type any-all.",
    ]);
  });
});

test("any-bare matches bare-name fallback behavior", { concurrency: false }, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "any-bare",
    });

    assert.ok(result.text.includes("quat: any;"));
    assert.equal(result.warnings[0], "Unresolved bare type 'Quternion' encountered; replaced with 'any' due to --unresolved-type any.");
  });
});

test("alias-any mode preserves unresolved name and emits fallback alias", { concurrency: false }, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "alias-any",
    });

    assert.ok(result.text.includes("quat: Quternion;"));
    assert.ok(result.text.includes("declare type Quternion = any;"));
    assert.equal(result.warnings[0], "Unresolved bare type 'Quternion' encountered; preserving name and emitting 'declare type Quternion = any'.");
  });
});
