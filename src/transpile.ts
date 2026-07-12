import { execFile as _execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";

import {
  collectMetaFiles,
  loadAggregatedDocuments,
  resolveJsonPath,
  toJsonPath,
} from "./lib/file-utils.js";
import { toValidTypeName } from "./lib/name-utils.js";
import { buildStatementsForDocument } from "./lib/statement-builder.js";
import {
  createTypeResolutionContext,
  setActiveTypeResolutionContext,
} from "./lib/type-utils.js";
import type {
  CliOptions,
  GenerationResult,
  LoadedDocument,
  UnresolvedTypeMode,
} from "./lib/types.js";

const execFile = promisify(_execFile);

export type { CliOptions, GenerationResult, UnresolvedTypeMode };
export { collectMetaFiles };

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const sourceIsDirectory = await fs
    .stat(path.resolve(parsed.options.sourcePath))
    .then(
      (stat) => stat.isDirectory(),
      () => false,
    );

  if (parsed.help) {
    printHelp();
    return 0;
  }

  const outputMode = resolveOutputMode(parsed.options, sourceIsDirectory);

  if (outputMode.kind === "directory") {
    const perFile = await generateDeclarationsPerFile(parsed.options);

    for (const item of perFile) {
      const outFull = path.resolve(outputMode.outDir, item.relativePath);
      await fs.mkdir(path.dirname(outFull), { recursive: true });
      await fs.writeFile(outFull, item.text, "utf8");

      for (const warning of item.warnings) {
        process.stderr.write(`${item.relativePath}: ${warning}\n`);
      }
    }
  } else {
    const result = await generateDeclarations(parsed.options);

    for (const warning of result.warnings) {
      process.stderr.write(`${warning}\n`);
    }

    if (parsed.options.outPath) {
      await fs.mkdir(path.dirname(path.resolve(parsed.options.outPath)), {
        recursive: true,
      });
      await fs.writeFile(parsed.options.outPath, result.text, "utf8");
    } else {
      process.stdout.write(result.text);
    }
  }

  return 0;
}

function resolveOutputMode(
  options: CliOptions,
  sourceIsDirectory: boolean,
):
  | { kind: "stdout" }
  | { kind: "file"; outPath: string }
  | { kind: "directory"; outDir: string } {
  if (options.outDir) {
    return { kind: "directory", outDir: options.outDir };
  }

  if (!options.outPath) {
    return { kind: "stdout" };
  }

  const looksDirectoryLike = path.extname(options.outPath) === "";
  if (sourceIsDirectory && looksDirectoryLike) {
    return { kind: "directory", outDir: options.outPath };
  }

  return { kind: "file", outPath: options.outPath };
}

export async function generateDeclarations(
  options: CliOptions,
): Promise<GenerationResult> {
  const sourcePath = path.resolve(options.sourcePath);
  const sourceStat = await fs.stat(sourcePath);
  const sourceRoot = sourceStat.isDirectory()
    ? sourcePath
    : path.dirname(sourcePath);
  const metaFiles = await collectMetaFiles(
    sourcePath,
    options.includePatterns,
    options.excludePatterns,
  );
  const warnings: string[] = [];
  const documents = await loadDocuments({
    sourcePath,
    sourceRoot,
    sourceStatIsDirectory: sourceStat.isDirectory(),
    metaFiles,
    jsonPath: options.jsonPath,
    cliExecTarget: sourcePath,
  });
  const unresolvedTypeMode = options.unresolvedTypeMode ?? "nonstrict";
  const knownTypeNames = collectKnownTypeNames(documents);
  const resolutionContext = createTypeResolutionContext({
    mode: unresolvedTypeMode,
    knownTypeNames,
    warnings,
  });
  setActiveTypeResolutionContext(resolutionContext);

  const statements: ts.Statement[] = [];
  try {
    statements.push(
      ...documents.flatMap(({ metaFile, document }) =>
        buildStatementsForDocument(
          metaFile,
          document,
          warnings,
          knownTypeNames,
        ),
      ),
    );
  } finally {
    setActiveTypeResolutionContext(undefined);
  }

  if (
    unresolvedTypeMode === "strict" &&
    resolutionContext.unresolvedTypeNames.size > 0
  ) {
    const unresolvedList = [...resolutionContext.unresolvedTypeNames].sort(
      (left, right) => left.localeCompare(right),
    );
    throw new Error(
      `Strict unresolved type check failed. Resolve these type names in source metadata: ${unresolvedList.join(", ")}\n` +
        "If you still want to emit .d.ts, rerun with --unresolved-type nonstrict, any, any-bare, any-all, unknown, or alias-any.",
    );
  }

  if (unresolvedTypeMode === "alias-any") {
    const aliasStatements = [...resolutionContext.unresolvedAliasNames]
      .filter((name) => !knownTypeNames.has(name))
      .sort((left, right) => left.localeCompare(right))
      .map((name) =>
        ts.factory.createTypeAliasDeclaration(
          [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
          ts.factory.createIdentifier(name),
          undefined,
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
        ),
      );
    statements.push(...aliasStatements);
  }

  const sourceFile = ts.factory.createSourceFile(
    statements,
    ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
    ts.NodeFlags.None,
  );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const noCheckPrefix = options.noCheck ? "// @ts-nocheck\n" : "";
  const text = `${noCheckPrefix}// Generated from EmmyLua meta Lua + emmylua_doc_cli JSON. Do not edit by hand.\n${printer.printFile(sourceFile)}`;

  return { text, warnings };
}

export async function generateDeclarationsPerFile(
  options: CliOptions,
): Promise<Array<{ relativePath: string; text: string; warnings: string[] }>> {
  const sourcePath = path.resolve(options.sourcePath);
  const sourceStat = await fs.stat(sourcePath);
  const sourceRoot = sourceStat.isDirectory()
    ? sourcePath
    : path.dirname(sourcePath);
  const metaFiles = await collectMetaFiles(
    sourcePath,
    options.includePatterns,
    options.excludePatterns,
  );
  const documents = await loadDocuments({
    sourcePath,
    sourceRoot,
    sourceStatIsDirectory: sourceStat.isDirectory(),
    metaFiles,
    jsonPath: options.jsonPath,
    cliExecTarget: sourceStat.isDirectory() ? sourceRoot : sourcePath,
  });

  const knownTypeNames = collectKnownTypeNames(documents);

  const results: Array<{
    relativePath: string;
    text: string;
    warnings: string[];
  }> = [];

  for (const { metaFile, document } of documents) {
    const warnings: string[] = [];
    const unresolvedTypeMode = options.unresolvedTypeMode ?? "nonstrict";

    const resolutionContext = createTypeResolutionContext({
      mode: unresolvedTypeMode,
      knownTypeNames,
      warnings,
    });

    setActiveTypeResolutionContext(resolutionContext);

    const statements: ts.Statement[] = [];
    try {
      statements.push(
        ...buildStatementsForDocument(
          metaFile,
          document,
          warnings,
          knownTypeNames,
        ),
      );
    } finally {
      setActiveTypeResolutionContext(undefined);
    }

    if (
      unresolvedTypeMode === "strict" &&
      resolutionContext.unresolvedTypeNames.size > 0
    ) {
      const unresolvedList = [...resolutionContext.unresolvedTypeNames].sort(
        (left, right) => left.localeCompare(right),
      );
      throw new Error(
        `Strict unresolved type check failed for ${metaFile}. Resolve these type names in source metadata: ${unresolvedList.join(", ")}`,
      );
    }

    if (unresolvedTypeMode === "alias-any") {
      const aliasStatements = [...resolutionContext.unresolvedAliasNames]
        .filter((name) => !knownTypeNames.has(name))
        .sort((left, right) => left.localeCompare(right))
        .map((name) =>
          ts.factory.createTypeAliasDeclaration(
            [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
            ts.factory.createIdentifier(name),
            undefined,
            ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
          ),
        );
      statements.push(...aliasStatements);
    }

    const sourceFile = ts.factory.createSourceFile(
      statements,
      ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
      ts.NodeFlags.None,
    );
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const noCheckPrefix = options.noCheck ? "// @ts-nocheck\n" : "";
    const text = `${noCheckPrefix}// Generated from EmmyLua meta Lua + emmylua_doc_cli JSON. Do not edit by hand.\n${printer.printFile(sourceFile)}`;

    const relativePath = path
      .relative(sourceRoot, metaFile)
      .replace(/\.meta\.lua$/i, ".d.ts")
      .replace(/\.lua$/i, ".d.ts");
    results.push({ relativePath, text, warnings });
  }

  return results;
}

function parseArgs(argv: string[]): { help: boolean; options: CliOptions } {
  let help = false;
  let sourcePath: string | undefined;
  let jsonPath: string | undefined;
  let outPath: string | undefined;
  let outDir: string | undefined;
  const includePatterns: string[] = [];
  const excludePatterns: string[] = [];
  let unresolvedTypeMode: UnresolvedTypeMode = "nonstrict";
  let noCheck = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === undefined) {
      break;
    }

    if (argument === "-h" || argument === "--help") {
      help = true;
      continue;
    }

    if (argument === "--json") {
      jsonPath = requireValue("--json", argv, ++index);
      continue;
    }

    if (argument === "--out") {
      outPath = requireValue("--out", argv, ++index);
      continue;
    }

    if (argument === "--out-dir") {
      outDir = requireValue("--out-dir", argv, ++index);
      continue;
    }

    if (argument === "--include") {
      includePatterns.push(requireValue("--include", argv, ++index));
      continue;
    }

    if (argument === "--exclude") {
      excludePatterns.push(requireValue("--exclude", argv, ++index));
      continue;
    }

    if (argument === "-o") {
      outPath = requireValue("-o", argv, ++index);
      continue;
    }

    if (argument === "--unresolved-type") {
      const value = requireValue("--unresolved-type", argv, ++index);
      if (
        value !== "strict" &&
        value !== "nonstrict" &&
        value !== "any" &&
        value !== "unknown" &&
        value !== "alias-any" &&
        value !== "any-bare" &&
        value !== "any-all"
      ) {
        throw new Error(`Invalid value for --unresolved-type: ${value}`);
      }
      unresolvedTypeMode = value;
      continue;
    }

    if (argument === "--no-check") {
      noCheck = true;
      continue;
    }

    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    }

    if (sourcePath !== undefined) {
      throw new Error(`Unexpected extra positional argument: ${argument}`);
    }

    sourcePath = argument;
  }

  return {
    help,
    options: {
      sourcePath: sourcePath ?? "sample",
      jsonPath,
      outPath,
      outDir,
      includePatterns: includePatterns.length > 0 ? includePatterns : undefined,
      excludePatterns: excludePatterns.length > 0 ? excludePatterns : undefined,
      unresolvedTypeMode,
      noCheck,
    },
  };
}

function requireValue(
  optionName: string,
  argv: string[],
  valueIndex: number,
): string {
  const value = argv[valueIndex];

  if (value === undefined) {
    throw new Error(`Missing value for ${optionName}`);
  }

  return value;
}

function printHelp(): void {
  process.stdout.write(`
emmylua-to-tstl

Usage:
  emmylua-to-tstl <source>.lua|<source-dir> [--out <file>] [--unresolved-type <strict|nonstrict|any|unknown|alias-any|any-bare|any-all>]

Options:
  --out, -o <path> Output .d.ts file path
  --out-dir <dir>  Emit one .d.ts per input .lua under <dir>
  --include <glob>  Include only files matching the glob (may be repeated)
  --exclude <glob>  Exclude files matching the glob (may be repeated)
  --unresolved-type <mode>
                  How to handle unresolved type names:
                  strict | nonstrict (default) | any | unknown | alias-any | any-bare | any-all
  --no-check      Prefix generated .d.ts with \`// @ts-nocheck\`
  -h, --help      Show this help message

Examples:
  emmylua-to-tstl sample --out dist/example_types.d.ts
  emmylua-to-tstl sample/example_types.lua --out sample/example_types.d.ts
  emmylua-to-tstl sample --out sample/example_types.d.ts --unresolved-type strict
  emmylua-to-tstl sample --out sample/example_types.d.ts --unresolved-type alias-any
  emmylua-to-tstl sample --out sample/example_types.d.ts --unresolved-type unknown
  emmylua-to-tstl sample --out sample/example_types.d.ts --unresolved-type any-bare
  emmylua-to-tstl sample --out sample/example_types.d.ts --unresolved-type any-all
`);
}

async function loadDocuments(options: {
  sourcePath: string;
  sourceRoot: string;
  sourceStatIsDirectory: boolean;
  metaFiles: string[];
  jsonPath: string | undefined;
  cliExecTarget: string;
}): Promise<LoadedDocument[]> {
  const jsonRoot = options.jsonPath
    ? path.resolve(options.jsonPath)
    : undefined;
  let effectiveJsonRoot: string | undefined = jsonRoot;
  let generatedJsonPath: string | undefined;

  if (!effectiveJsonRoot) {
    let allJsonExist = true;
    for (const metaFile of options.metaFiles) {
      const candidate = toJsonPath(metaFile);
      try {
        await fs.access(candidate);
      } catch {
        allJsonExist = false;
        break;
      }
    }

    if (!allJsonExist) {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "emmylua-doc-"));
      try {
        await execFile(
          "emmylua_doc_cli",
          [
            "--output-format",
            "json",
            "--output",
            tmpDir,
            options.cliExecTarget,
          ],
          {
            cwd: options.sourceRoot,
          },
        );
        effectiveJsonRoot = tmpDir;
        generatedJsonPath = path.join(tmpDir, "doc.json");
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not generate JSON via 'emmylua_doc_cli': ${errorMessage}. ` +
            "Install 'emmylua_doc_cli' or provide pre-generated JSON via --json <path>.",
        );
      }
    }
  }

  if (generatedJsonPath) {
    return loadAggregatedDocuments({
      jsonPath: generatedJsonPath,
      fallbackMetaFile: options.sourcePath,
    });
  }

  return Promise.all(
    options.metaFiles.map(async (metaFile) => {
      const jsonPath = await resolveJsonPath({
        metaFile,
        sourceRoot: options.sourceRoot,
        jsonRoot: effectiveJsonRoot,
      });
      const jsonText = await fs.readFile(jsonPath, "utf8");
      return {
        metaFile,
        jsonPath,
        document: JSON.parse(jsonText),
      };
    }),
  );
}

function collectKnownTypeNames(documents: LoadedDocument[]): Set<string> {
  const knownTypeNames = new Set<string>();
  for (const { document } of documents) {
    for (const entry of document.types ?? []) {
      if (entry.type === "class" || entry.type === "enum") {
        knownTypeNames.add(toValidTypeName(entry.name));
      }
    }
  }
  return knownTypeNames;
}
