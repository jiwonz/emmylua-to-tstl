import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  const jsonPath = toJsonFixturePath(metaPath);

  await writeFile(metaPath, "---@meta\n", "utf8");
  await writeFile(jsonPath, JSON.stringify(document, null, 2), "utf8");

  return fixtureRoot;
}

async function createDirectoryFixture(files: Array<{ filePath: string; document: TestMetaDocument }>): Promise<string> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "emmylua-to-tstl-test-"));

  for (const file of files) {
    const metaPath = path.join(fixtureRoot, file.filePath);
    const jsonPath = toJsonFixturePath(metaPath);
    await mkdir(path.dirname(metaPath), { recursive: true });
    await writeFile(metaPath, "---@meta\n", "utf8");
    await writeFile(jsonPath, JSON.stringify(file.document, null, 2), "utf8");
  }

  return fixtureRoot;
}

function toJsonFixturePath(metaPath: string): string {
  return metaPath.replace(/\.meta\.lua$/i, ".json").replace(/\.lua$/i, ".json");
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
    static makeValue(): DemoColor;
    static makeValue(hex: string): DemoColor;
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
    static makeValue(): DemoColor;
    static makeValue(hex: string): DemoColor;
}`),
    );
    assert.deepEqual(result.warnings, [
      "Unresolved bare type 'MissingType' encountered; replaced with 'any' due to --unresolved-type any.",
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
    static makeValue(): DemoColor;
    static makeValue(hex: string): DemoColor;
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
      "Unresolved bare type 'MissingType' encountered; replaced with 'any' due to --unresolved-type any.",
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

test("directory input with directory-like -o writes per-file outputs", {
  concurrency: false,
}, async () => {
  const fixtureRoot = await createDirectoryFixture([
    {
      filePath: path.join("lsp-meta", "ko", "DemoNamespace.meta.lua"),
      document: buildBaseDocument(),
    },
    {
      filePath: path.join("lsp-meta", "ko", "AuxNamespace.meta.lua"),
      document: buildSecondaryDocument(),
    },
  ]);
  const outDir = path.join(fixtureRoot, "generated", "definitions");

  try {
    const exitCode = await runCli([path.join(fixtureRoot, "lsp-meta", "ko"), "-o", outDir]);
    assert.equal(exitCode, 0);

    const entries = await readdir(outDir, { withFileTypes: true });
    const outputFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();

    assert.deepEqual(outputFiles, ["AuxNamespace.d.ts", "DemoNamespace.d.ts"]);

    const demoText = await readFile(path.join(outDir, "DemoNamespace.d.ts"), "utf8");
    const auxText = await readFile(path.join(outDir, "AuxNamespace.d.ts"), "utf8");

    assert.ok(demoText.includes("declare class DemoClass"));
    assert.ok(demoText.includes("unknownValue: MissingType;"));
    assert.ok(auxText.includes("declare class AuxClass"));
    assert.ok(auxText.includes("declare function doThing(this: void, input: string): void;"));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
