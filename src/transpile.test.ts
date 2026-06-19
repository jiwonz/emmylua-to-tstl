import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectMetaFiles, generateDeclarations, runCli } from "./transpile.js";

interface TestMetaDocument {
  modules?: unknown[];
  types: unknown[];
  globals?: unknown[];
}

async function createFixture(
  document: TestMetaDocument,
  fileName = "fixture.lua",
): Promise<string> {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "emmylua-to-tstl-test-"),
  );
  const metaPath = path.join(fixtureRoot, fileName);
  const jsonPath = metaPath.replace(/\.meta\.lua$/i, ".json").replace(/\.lua$/i, ".json");

  await writeFile(metaPath, "---@meta\n", "utf8");
  await writeFile(jsonPath, JSON.stringify(document, null, 2), "utf8");

  return fixtureRoot;
}

async function createDirectoryFixture(files: Array<{ filePath: string; document: TestMetaDocument }>): Promise<string> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "emmylua-to-tstl-test-"));

  for (const file of files) {
    const metaPath = path.join(fixtureRoot, file.filePath);
    const jsonPath = metaPath.replace(/\.meta\.lua$/i, ".json").replace(/\.lua$/i, ".json");
    await mkdir(path.dirname(metaPath), { recursive: true });
    await writeFile(metaPath, "---@meta\n", "utf8");
    await writeFile(jsonPath, JSON.stringify(file.document, null, 2), "utf8");
  }

  return fixtureRoot;
}

async function withFixture<T>(
  document: TestMetaDocument,
  run: (fixtureRoot: string) => Promise<T>,
  fileName = "fixture.lua",
): Promise<T> {
  const fixtureRoot = await createFixture(document, fileName);

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
        name: "DemoClass",
        members: [
          {
            type: "field",
            name: "unknownValue",
            typ: "MissingType",
          },
          {
            type: "field",
            name: "serviceThing",
            typ: "DemoNamespace.DemoObject",
          },
          {
            type: "fn",
            name: "makeValue",
            is_meth: false,
            params: [],
            returns: [{ typ: "DemoColor" }],
          },
          {
            type: "fn",
            name: "makeValue",
            is_meth: false,
            params: [{ name: "hex", typ: "string" }],
            returns: [{ typ: "DemoColor" }],
          },
        ],
      },
      {
        type: "class",
        name: "DemoColor",
        members: [],
      },
    ],
    globals: [],
  };
}

function buildSecondaryDocument(): TestMetaDocument {
  return {
    types: [
      {
        type: "class",
        name: "AuxClass",
        members: [
          {
            type: "field",
            name: "value",
            typ: "number",
          },
        ],
      },
    ],
    globals: [
      {
        type: "fn",
        name: "doThing",
        is_meth: false,
        params: [{ name: "input", typ: "string" }],
        returns: [{ typ: "void" }],
      },
    ],
  };
}

function buildEnumDocument(): TestMetaDocument {
  return {
    types: [
      {
        type: "enum",
        name: "DemoEnum",
        baseType: "number",
        fields: [{ name: "Red" }, { name: "Green" }, { name: "Blue" }],
      },
    ],
    globals: [],
  };
}

function buildQualifiedNamespaceDocument(): TestMetaDocument {
  return {
    types: [
      {
        type: "class",
        name: "DemoFramework",
        members: [],
      },
      {
        type: "enum",
        name: "DemoFramework.AnimatorUpdateMode",
        baseType: "number",
        fields: [
          { name: "Normal", value: "0" },
          { name: "AnimatePhysics", value: "1" },
          { name: "UnscaledTime", value: "2" },
        ],
      },
      {
        type: "class",
        name: "DemoFramework.UI.Button",
        members: [],
      },
    ],
    globals: [],
  };
}

test("nonstrict keeps unresolved names and emits static overloads", {
  concurrency: false,
}, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "nonstrict",
    });

    assert.ok(
      result.text.includes(`declare class DemoClass {
    private constructor();
    serviceThing: DemoNamespace.DemoObject;
    unknownValue: MissingType;
    static makeValue(this: void): DemoColor;
    static makeValue(this: void, hex: string): DemoColor;
}`),
    );
    assert.equal(result.warnings.length, 0);
  });
});

test("strict fails conversion when unresolved types are present", {
  concurrency: false,
}, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
    await assert.rejects(
      () =>
        generateDeclarations({
          sourcePath: fixtureRoot,
          jsonPath: undefined,
          outPath: undefined,
          unresolvedTypeMode: "strict",
        }),
      /Strict unresolved type check failed[\s\S]*MissingType/,
    );
  });
});

test("any mode replaces unresolved bare types with any", {
  concurrency: false,
}, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "any",
    });

    assert.ok(
      result.text.includes(`declare class DemoClass {
    private constructor();
    serviceThing: DemoNamespace.DemoObject;
    unknownValue: any;
    static makeValue(this: void): DemoColor;
    static makeValue(this: void, hex: string): DemoColor;
}`),
    );
    assert.deepEqual(result.warnings, [
      "Unresolved bare type 'MissingType' encountered; replaced with 'any' due to --unresolved-type any.",
    ]);
  });
});

test("unknown mode replaces unresolved types with unknown", {
  concurrency: false,
}, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "unknown",
    });

    assert.ok(
      result.text.includes(`declare class DemoClass {
    private constructor();
    serviceThing: unknown;
    unknownValue: unknown;
    static makeValue(this: void): DemoColor;
    static makeValue(this: void, hex: string): DemoColor;
}`),
    );
    assert.deepEqual(result.warnings, [
      "Unresolved type 'DemoNamespace.DemoObject' encountered; replaced with 'unknown' due to --unresolved-type unknown.",
      "Unresolved type 'MissingType' encountered; replaced with 'unknown' due to --unresolved-type unknown.",
    ]);
  });
});

test("any-all mode replaces qualified unresolved types with any", {
  concurrency: false,
}, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "any-all",
    });

    assert.ok(
      result.text.includes(`declare class DemoClass {
    private constructor();
    serviceThing: any;
    unknownValue: any;
    static makeValue(this: void): DemoColor;
    static makeValue(this: void, hex: string): DemoColor;
}`),
    );
    assert.deepEqual(result.warnings, [
      "Unresolved type 'DemoNamespace.DemoObject' encountered; replaced with 'any' due to --unresolved-type any-all.",
      "Unresolved type 'MissingType' encountered; replaced with 'any' due to --unresolved-type any-all.",
    ]);
  });
});

test("any-bare matches bare-name fallback behavior", {
  concurrency: false,
}, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "any-bare",
    });

    assert.ok(result.text.includes("unknownValue: any;"));
    assert.equal(
      result.warnings[0],
      "Unresolved bare type 'MissingType' encountered; replaced with 'any' due to --unresolved-type any-bare.",
    );
  });
});

test("alias-any mode preserves unresolved name and emits fallback alias", {
  concurrency: false,
}, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
    const result = await generateDeclarations({
      sourcePath: fixtureRoot,
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "alias-any",
    });

    assert.ok(result.text.includes("unknownValue: MissingType;"));
    assert.ok(result.text.includes("declare type MissingType = any;"));
    assert.equal(
      result.warnings[0],
      "Unresolved bare type 'MissingType' encountered; preserving name and emitting 'declare type MissingType = any'.",
    );
  });
});

test("collectMetaFiles walks nested lua files in a directory", {
  concurrency: false,
}, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
    const nestedDir = path.join(fixtureRoot, "lsp-meta", "ko");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(path.join(nestedDir, "nested.lua"), "---@meta\n", "utf8");
    await writeFile(path.join(nestedDir, "nested.json"), JSON.stringify(buildSecondaryDocument(), null, 2), "utf8");
    await writeFile(path.join(nestedDir, "nested-meta.meta.lua"), "---@meta\n", "utf8");
    await writeFile(path.join(nestedDir, "nested-meta.json"), JSON.stringify(buildSecondaryDocument(), null, 2), "utf8");

    const files = await collectMetaFiles(fixtureRoot);
    assert.deepEqual(
      files.map((file) => path.relative(fixtureRoot, file).split(path.sep).join("/")).sort(),
      ["fixture.lua", "lsp-meta/ko/nested-meta.meta.lua", "lsp-meta/ko/nested.lua"],
    );
  });
});

test("direct .meta.lua input is accepted and generates declarations", {
  concurrency: false,
}, async () => {
  await withFixture(buildBaseDocument(), async (fixtureRoot) => {
    const result = await generateDeclarations({
      sourcePath: path.join(fixtureRoot, "fixture.meta.lua"),
      jsonPath: undefined,
      outPath: undefined,
      unresolvedTypeMode: "nonstrict",
    });

    assert.ok(result.text.includes("declare class DemoClass"));
    assert.ok(result.text.includes("unknownValue: MissingType;"));
  }, "fixture.meta.lua");
});

test("directory input with -o out writes a combined d.ts file", {
  concurrency: false,
}, async () => {
  const fixtureRoot = await createDirectoryFixture([
    { filePath: path.join("lsp-meta", "ko", "DemoNamespace.lua"), document: buildBaseDocument() },
  ]);
  const outFile = path.join(fixtureRoot, "generated", "definitions.d.ts");

  try {
    const exitCode = await runCli([path.join(fixtureRoot, "lsp-meta", "ko"), "-o", outFile]);
    assert.equal(exitCode, 0);

    const text = await readFile(outFile, "utf8");
    assert.ok(text.includes("declare class DemoClass"));
    assert.ok(text.includes("unknownValue: MissingType;"));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("enum.meta.lua emits a populated enum.d.ts file", {
  concurrency: false,
}, async () => {
  const fixtureRoot = await createDirectoryFixture([
    { filePath: "enum.meta.lua", document: buildEnumDocument() },
  ]);
  const outDir = path.join(fixtureRoot, "generated");

  try {
    const exitCode = await runCli([fixtureRoot, "-o", outDir]);
    assert.equal(exitCode, 0);

    const text = await readFile(path.join(outDir, "enum.d.ts"), "utf8");
    assert.ok(text.includes("declare enum DemoEnum"));
    assert.ok(text.includes("Red"));
    assert.ok(text.includes("Green"));
    assert.ok(text.includes("Blue"));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("qualified declarations emit namespaces", {
  concurrency: false,
}, async () => {
  const fixtureRoot = await createDirectoryFixture([
    { filePath: "DemoFramework.meta.lua", document: buildQualifiedNamespaceDocument() },
  ]);
  const outDir = path.join(fixtureRoot, "generated");

  try {
    const exitCode = await runCli([fixtureRoot, "-o", outDir]);
    assert.equal(exitCode, 0);

    const text = await readFile(path.join(outDir, "DemoFramework.d.ts"), "utf8");
    assert.ok(text.includes("declare namespace DemoFramework"));
    assert.ok(text.includes("export enum AnimatorUpdateMode"));
    assert.ok(text.includes("Normal = 0"));
    assert.ok(text.includes("namespace UI"));
    assert.ok(text.includes("export class Button"));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
