import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFile = promisify(_execFile);

export interface CliOptions {
  sourcePath: string;
  jsonPath: string | undefined;
  outPath: string | undefined;
  outDir?: string | undefined;
  includePatterns?: string[] | undefined;
  excludePatterns?: string[] | undefined;
  unresolvedTypeMode?: UnresolvedTypeMode;
}

export type UnresolvedTypeMode =
  | "strict"
  | "nonstrict"
  | "any"
  | "alias-any"
  | "any-bare"
  | "any-all";

interface MetaDocument {
  modules?: unknown[];
  types: MetaTypeEntry[];
  globals?: MetaTypeEntry[];
}

interface MetaLoc {
  file?: string;
  line?: number;
}

interface MetaBaseEntry {
  type: string;
  name: string;
  description?: string | null;
  loc?: MetaLoc | MetaLoc[] | null;
}

interface MetaClassEntry extends MetaBaseEntry {
  type: "class";
  bases?: string[];
  generics?: string[];
  members?: MetaMemberEntry[];
}

interface MetaFieldEntry extends MetaBaseEntry {
  type: "field";
  typ?: string;
  literal?: unknown;
}

interface MetaFnParam {
  name: string;
  typ?: string;
  desc?: string;
}

interface MetaFnReturn {
  name?: string | null;
  typ?: string;
  desc?: string;
}

interface MetaFnEntry extends MetaBaseEntry {
  type: "fn";
  generics?: Array<string | MetaGenericEntry>;
  params?: MetaFnParam[];
  returns?: MetaFnReturn[];
  overloads?: MetaFnEntry[];
  is_meth?: boolean;
  is_async?: boolean;
  is_nodiscard?: boolean;
  nodiscard_message?: string | null;
}

interface MetaGenericEntry {
  name?: string;
  base?: string | null;
}

type MetaTypeEntry = MetaClassEntry | MetaFieldEntry | MetaFnEntry;
type MetaMemberEntry = MetaFieldEntry | MetaFnEntry;

interface FunctionSignatureSpec {
  typeParameters: ts.TypeParameterDeclaration[];
  parameters: ts.ParameterDeclaration[];
  returnType: ts.TypeNode;
}

interface GenerationResult {
  text: string;
  warnings: string[];
}

interface TypeResolutionContext {
  mode: UnresolvedTypeMode;
  knownTypeNames: Set<string>;
  unresolvedTypeNames: Set<string>;
  unresolvedAliasNames: Set<string>;
  warnedUnresolvedNames: Set<string>;
  warnings: string[];
}

const LUA_FUNCTION_RE =
  /^fun(?:<(?<generics>[^>]*)>)?\((?<params>.*)\)(?:\s*->\s*(?<returns>.*))?$/s;

const RESERVED_TOP_LEVEL_NAMES = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const KNOWN_BUILTIN_TYPE_NAMES = new Set([
  "any",
  "Array",
  "ReadonlyArray",
  "Record",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Date",
  "Error",
  "RegExp",
  "Uint8Array",
  "Uint16Array",
  "Uint32Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "NonNullable",
  "Parameters",
  "ConstructorParameters",
  "ReturnType",
  "InstanceType",
  "ThisType",
  "Uppercase",
  "Lowercase",
  "Capitalize",
  "Uncapitalize",
  "NoInfer",
  "LuaMultiReturn",
  "boolean",
  "number",
  "string",
  "symbol",
  "bigint",
  "unknown",
  "never",
  "void",
  "undefined",
  "null",
  "object",
  "true",
  "false",
  "this",
  "readonly",
  "keyof",
  "infer",
  "extends",
]);

const BARE_UNRESOLVED_TYPE_RE = /\b([A-Z_][A-Za-z0-9_]*)\b/g;
const QUALIFIED_UNRESOLVED_TYPE_RE =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\b/g;

let activeTypeResolutionContext: TypeResolutionContext | undefined;

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.help) {
    printHelp();
    return 0;
  }

  if (parsed.options.outDir) {
    if (parsed.options.outPath) {
      throw new Error("Cannot specify both --out and --out-dir");
    }

    const perFile = await generateDeclarationsPerFile(parsed.options);

    for (const item of perFile) {
      const outFull = path.resolve(parsed.options.outDir, item.relativePath);
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

export async function generateDeclarations(
  options: CliOptions,
): Promise<GenerationResult> {
  const sourcePath = path.resolve(options.sourcePath);
  const sourceStat = await fs.stat(sourcePath);
  const sourceRoot = sourceStat.isDirectory()
    ? sourcePath
    : path.dirname(sourcePath);
  const metaFiles = await collectMetaFiles(sourcePath, options.includePatterns, options.excludePatterns);
  const warnings: string[] = [];
  const jsonRoot = options.jsonPath
    ? path.resolve(options.jsonPath)
    : undefined;
  let effectiveJsonRoot: string | undefined = jsonRoot;

  // If the caller didn't provide a JSON root, and JSON files next to .lua are missing,
  // attempt to invoke `emmylua_doc_cli` to generate JSON into a temporary directory.
  if (!effectiveJsonRoot) {
    let allJsonExist = true;
    for (const metaFile of metaFiles) {
      const candidate = metaFile.replace(/\.lua$/i, ".json");
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
        // Try to run emmylua_doc_cli against the source root, emitting JSON into tmpDir.
        // This requires `emmylua_doc_cli` to be on PATH. If it fails, surface a helpful error.
        await execFile("emmylua_doc_cli", ["--out", tmpDir, sourceRoot], {
          cwd: sourceRoot,
        });
        effectiveJsonRoot = tmpDir;
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
  const unresolvedTypeMode = options.unresolvedTypeMode ?? "nonstrict";

  const documents = await Promise.all(
    metaFiles.map(async (metaFile) => {
      const jsonPath = await resolveJsonPath({
        metaFile,
        sourceRoot,
        jsonRoot: effectiveJsonRoot,
      });
      const jsonText = await fs.readFile(jsonPath, "utf8");
      const document = JSON.parse(jsonText) as MetaDocument;
      return { metaFile, jsonPath, document };
    }),
  );

  const knownTypeNames = new Set<string>();
  for (const { document } of documents) {
    for (const entry of document.types ?? []) {
      if (entry.type === "class") {
        knownTypeNames.add(toValidTypeName(entry.name));
      }
    }
  }

  const resolutionContext: TypeResolutionContext = {
    mode: unresolvedTypeMode,
    knownTypeNames,
    unresolvedTypeNames: new Set<string>(),
    unresolvedAliasNames: new Set<string>(),
    warnedUnresolvedNames: new Set<string>(),
    warnings,
  };
  activeTypeResolutionContext = resolutionContext;

  const statements: ts.Statement[] = [];
  try {
    statements.push(
      ...documents.flatMap(({ metaFile, document }) =>
        buildStatementsForDocument(metaFile, document, warnings),
      ),
    );
  } finally {
    activeTypeResolutionContext = undefined;
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
        "If you still want to emit .d.ts, rerun with --unresolved-type nonstrict, any, any-bare, any-all, or alias-any.",
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
  const text = `// Generated from EmmyLua meta Lua + emmylua_doc_cli JSON. Do not edit by hand.\n${printer.printFile(sourceFile)}`;

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
  const metaFiles = await collectMetaFiles(sourcePath, options.includePatterns, options.excludePatterns);
  const jsonRoot = options.jsonPath
    ? path.resolve(options.jsonPath)
    : undefined;
  let effectiveJsonRoot: string | undefined = jsonRoot;

  if (!effectiveJsonRoot) {
    let allJsonExist = true;
    for (const metaFile of metaFiles) {
      const candidate = metaFile.replace(/\.meta\.lua$/i, ".json");
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
        await execFile("emmylua_doc_cli", ["--out", tmpDir, sourceRoot], {
          cwd: sourceRoot,
        });
        effectiveJsonRoot = tmpDir;
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

  const documents = await Promise.all(
    metaFiles.map(async (metaFile) => {
      const jsonPath = await resolveJsonPath({
        metaFile,
        sourceRoot,
        jsonRoot: effectiveJsonRoot,
      });
      const jsonText = await fs.readFile(jsonPath, "utf8");
      const document = JSON.parse(jsonText) as MetaDocument;
      return { metaFile, jsonPath, document };
    }),
  );

  const knownTypeNames = new Set<string>();
  for (const { document } of documents) {
    for (const entry of document.types ?? []) {
      if (entry.type === "class") {
        knownTypeNames.add(toValidTypeName(entry.name));
      }
    }
  }

  const results: Array<{
    relativePath: string;
    text: string;
    warnings: string[];
  }> = [];

  for (const { metaFile, document } of documents) {
    const warnings: string[] = [];
    const unresolvedTypeMode = options.unresolvedTypeMode ?? "nonstrict";

    const resolutionContext: TypeResolutionContext = {
      mode: unresolvedTypeMode,
      knownTypeNames,
      unresolvedTypeNames: new Set<string>(),
      unresolvedAliasNames: new Set<string>(),
      warnedUnresolvedNames: new Set<string>(),
      warnings,
    };

    activeTypeResolutionContext = resolutionContext;

    const statements: ts.Statement[] = [];
    try {
      statements.push(
        ...buildStatementsForDocument(metaFile, document, warnings),
      );
    } finally {
      activeTypeResolutionContext = undefined;
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
    const text = `// Generated from EmmyLua meta Lua + emmylua_doc_cli JSON. Do not edit by hand.\n${printer.printFile(sourceFile)}`;

    const relativePath = path
      .relative(sourceRoot, metaFile)
      .replace(/\.lua$/i, ".d.ts");
    results.push({ relativePath, text, warnings });
  }

  return results;
}

function globToRegExp(glob: string): RegExp {
  // Escape regex special chars except * and ?
  let s = glob.replace(/([.+^${}()|[\]\\])/g, "\\$1");
  s = s.replace(/\*\*/g, "<<<TWOSTAR>>>");
  s = s.replace(/\*/g, "[^/]*");
  s = s.replace(/<<<TWOSTAR>>>/g, ".*");
  s = s.replace(/\?/g, ".");

  return new RegExp(`^${s}$`);
}

function matchesAny(relPath: string, patterns?: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const posixPath = relPath.split(path.sep).join("/");
  return patterns.some((p) => globToRegExp(p).test(posixPath));
}

export async function collectMetaFiles(
  inputPath: string,
  includePatterns?: string[] | undefined,
  excludePatterns?: string[] | undefined,
): Promise<string[]> {
  const resolvedInput = path.resolve(inputPath);
  const stat = await fs.stat(resolvedInput);

  if (stat.isFile()) {
    if (!resolvedInput.endsWith(".lua")) return [];
    const rel = path.basename(resolvedInput);
    if (excludePatterns && matchesAny(rel, excludePatterns)) return [];
    if (includePatterns && includePatterns.length > 0 && !matchesAny(rel, includePatterns)) return [];
    return [resolvedInput];
  }

  const files: string[] = [];
  await walkDirectory(resolvedInput, files);
  const filtered = files.filter((file) => file.endsWith(".lua")).filter((file) => {
    const rel = path.relative(resolvedInput, file).split(path.sep).join("/");
    if (excludePatterns && matchesAny(rel, excludePatterns)) return false;
    if (includePatterns && includePatterns.length > 0 && !matchesAny(rel, includePatterns)) return false;
    return true;
  });

  return filtered.sort((left, right) => left.localeCompare(right));
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
        value !== "alias-any" &&
        value !== "any-bare" &&
        value !== "any-all"
      ) {
        throw new Error(`Invalid value for --unresolved-type: ${value}`);
      }
      unresolvedTypeMode = value;
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
  emmylua-to-tstl <source>.lua|<source-dir> [--out <file>] [--unresolved-type <strict|nonstrict|any|alias-any|any-bare|any-all>]

Options:
  --out, -o <path> Output .d.ts file path
  --out-dir <dir>  Emit one .d.ts per input .lua under <dir>
  --include <glob>  Include only files matching the glob (may be repeated)
  --exclude <glob>  Exclude files matching the glob (may be repeated)
  --unresolved-type <mode>
                  How to handle unresolved type names:
                  strict | nonstrict (default) | any | alias-any | any-bare | any-all
  -h, --help      Show this help message

Examples:
  emmylua-to-tstl sample --out dist/example_types.d.ts
  emmylua-to-tstl sample/example_types.lua --out sample/example_types.d.ts
  emmylua-to-tstl sample --out sample/example_types.d.ts --unresolved-type strict
  emmylua-to-tstl sample --out sample/example_types.d.ts --unresolved-type alias-any
  emmylua-to-tstl sample --out sample/example_types.d.ts --unresolved-type any-bare
  emmylua-to-tstl sample --out sample/example_types.d.ts --unresolved-type any-all
`);
}

function buildStatementsForDocument(
  metaFile: string,
  document: MetaDocument,
  warnings: string[],
): ts.Statement[] {
  const typeEntries = Array.isArray(document.types) ? [...document.types] : [];
  typeEntries.sort(
    (left, right) =>
      getLine(left) - getLine(right) || left.name.localeCompare(right.name),
  );

  const classes = typeEntries.filter(
    (entry): entry is MetaClassEntry => entry.type === "class",
  );
  const classNames = new Set(classes.map((entry) => entry.name));
  const globalEntries = Array.isArray(document.globals)
    ? [...document.globals]
    : [];
  globalEntries.sort(
    (left, right) =>
      getLine(left) - getLine(right) || left.name.localeCompare(right.name),
  );
  const topLevelFields = globalEntries.filter(
    (entry): entry is MetaFieldEntry => entry.type === "field",
  );
  const topLevelFns = globalEntries.filter(
    (entry): entry is MetaFnEntry => entry.type === "fn",
  );
  const statements: ts.Statement[] = [];

  for (const classEntry of classes) {
    statements.push(buildClassDeclaration(classEntry));
  }

  const fieldGroups = groupByName(
    topLevelFields.filter(
      (entry) => !classNames.has(entry.name) && entry.typ !== undefined,
    ),
  );
  const groupedFieldNames = new Set(fieldGroups.keys());
  for (const [name, entries] of fieldGroups) {
    const first = entries[0];
    if (first === undefined) {
      continue;
    }

    if (entries.every((entry) => isFunctionType(entry.typ))) {
      if (isValidTopLevelName(name)) {
        statements.push(
          ...entries.map((entry) =>
            buildFunctionDeclarationFromField(entry, warnings),
          ),
        );
      } else {
        warnings.push(
          `Renamed invalid global identifier ${name} -> ${mangleTopLevelName(name)}`,
        );
        const functionType = createFunctionTypeNodeFromFieldEntry(
          first,
          warnings,
        );
        statements.push(
          createCustomNamedVariableStatement(
            mangleTopLevelName(name),
            functionType,
            name,
          ),
        );
      }
      continue;
    }

    statements.push(buildConstDeclaration(name, first, warnings));
  }

  const functionGroups = groupByName(topLevelFns);
  for (const [name, entries] of functionGroups) {
    if (!isValidTopLevelName(name)) {
      const first = entries[0];
      if (first !== undefined) {
        warnings.push(
          `Renamed invalid global identifier ${name} -> ${mangleTopLevelName(name)}`,
        );
        const signature = buildFunctionSignature(first, true);
        const functionType = ts.factory.createFunctionTypeNode(
          signature.typeParameters.length > 0
            ? signature.typeParameters
            : undefined,
          signature.parameters,
          signature.returnType,
        );
        statements.push(
          createCustomNamedVariableStatement(
            mangleTopLevelName(name),
            functionType,
            name,
          ),
        );
      }
      continue;
    }

    statements.push(...entries.map((entry) => buildFunctionDeclaration(entry)));
  }

  const duplicateFunctionNames = new Set(functionGroups.keys());
  for (const fieldEntry of topLevelFields) {
    if (
      classNames.has(fieldEntry.name) ||
      duplicateFunctionNames.has(fieldEntry.name) ||
      groupedFieldNames.has(fieldEntry.name)
    ) {
      continue;
    }

    if (!fieldEntry.typ) {
      continue;
    }

    if (isFunctionType(fieldEntry.typ)) {
      if (isValidTopLevelName(fieldEntry.name)) {
        statements.push(
          buildFunctionDeclarationFromField(fieldEntry, warnings),
        );
      } else {
        const mangledName = mangleTopLevelName(fieldEntry.name);
        warnings.push(
          `Renamed invalid global identifier ${fieldEntry.name} -> ${mangledName}`,
        );
        statements.push(
          buildConstDeclaration(
            mangledName,
            { ...fieldEntry, name: mangledName },
            warnings,
            fieldEntry.name,
          ),
        );
      }
      continue;
    }

    if (isValidTopLevelName(fieldEntry.name)) {
      statements.push(
        buildConstDeclaration(fieldEntry.name, fieldEntry, warnings),
      );
      continue;
    }

    const mangledName = mangleTopLevelName(fieldEntry.name);
    warnings.push(
      `Renamed invalid global identifier ${fieldEntry.name} -> ${mangledName}`,
    );
    statements.push(
      buildConstDeclaration(
        mangledName,
        { ...fieldEntry, name: mangledName },
        warnings,
        fieldEntry.name,
      ),
    );
  }

  if (document.modules && document.modules.length > 0) {
    warnings.push(
      `Ignoring ${document.modules.length} module entries from ${path.basename(metaFile)} because namespace emission is not yet implemented.`,
    );
  }

  return statements;
}

function buildClassDeclaration(entry: MetaClassEntry): ts.ClassDeclaration {
  const members = [...(entry.members ?? [])].sort(
    (left, right) =>
      getLine(left) - getLine(right) || left.name.localeCompare(right.name),
  );
  const classMembers: ts.ClassElement[] = [];
  const fieldGroups = groupByName(
    members.filter(
      (member): member is MetaFieldEntry => member.type === "field",
    ),
  );
  const fnGroups = groupByName(
    members.filter((member): member is MetaFnEntry => member.type === "fn"),
  );

  for (const member of members) {
    if (member.type !== "field") {
      continue;
    }

    const fieldGroup = fieldGroups.get(member.name);
    if (!fieldGroup || fieldGroup[0] !== member) {
      continue;
    }

    const fnGroup = fnGroups.get(member.name);
    if (fnGroup && fnGroup.length > 0) {
      classMembers.push(buildCallablePropertyDeclaration(member, fnGroup));
      continue;
    }

    classMembers.push(buildPropertyDeclaration(member));
  }

  for (const [name, group] of fnGroups) {
    if (fieldGroups.has(name)) {
      continue;
    }

    const staticMembers = group.filter((member) => member.is_meth === false);
    const instanceMembers = group.filter((member) => member.is_meth !== false);

    classMembers.push(
      ...instanceMembers.map((member) => buildMethodDeclaration(member, false)),
    );
    classMembers.push(
      ...staticMembers.map((member) => buildMethodDeclaration(member, true)),
    );
  }

  const heritageClauses = buildHeritageClauses(entry.bases ?? []);
  const typeParameters = buildTypeParameters(entry.generics ?? []);

  // If no constructor is declared, add a private constructor by default.
  // Lua/EmmyLua classes often expose static factory methods instead of a true constructor,
  // so making the ambient constructor private prevents `new` usage in TS while preserving static factories.
  const hasConstructor = classMembers.some((m) =>
    ts.isConstructorDeclaration(m),
  );
  if (!hasConstructor) {
    const privateCtor = ts.factory.createConstructorDeclaration(
      [ts.factory.createModifier(ts.SyntaxKind.PrivateKeyword)],
      [],
      undefined,
    );
    classMembers.unshift(privateCtor);
  }

  return ts.factory.createClassDeclaration(
    [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
    toValidTypeName(entry.name),
    typeParameters,
    heritageClauses,
    classMembers,
  );
}

function buildHeritageClauses(
  bases: string[],
): ts.HeritageClause[] | undefined {
  if (bases.length === 0) {
    return undefined;
  }

  return [
    ts.factory.createHeritageClause(
      ts.SyntaxKind.ExtendsKeyword,
      bases
        .slice(0, 1)
        .map((baseName) =>
          ts.factory.createExpressionWithTypeArguments(
            ts.factory.createIdentifier(baseName),
            undefined,
          ),
        ),
    ),
  ];
}

function buildTypeParameters(
  entries: Array<string | MetaGenericEntry>,
): ts.TypeParameterDeclaration[] | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  return entries.map((entry) => buildTypeParameterDeclaration(entry));
}

function buildTypeParameterDeclaration(
  entry: string | MetaGenericEntry,
): ts.TypeParameterDeclaration {
  const name = typeof entry === "string" ? entry : (entry.name ?? "T");
  const constraint =
    typeof entry === "string" || !entry.base
      ? undefined
      : createTypeNodeFromText(entry.base);

  return ts.factory.createTypeParameterDeclaration(
    undefined,
    ts.factory.createIdentifier(name),
    constraint,
    undefined,
  );
}

function buildMethodDeclaration(
  entry: MetaFnEntry,
  isStatic: boolean,
): ts.MethodDeclaration {
  // Class methods are emitted as real overloads. Static members use the `static` modifier,
  // while instance members remain regular methods.
  const signature = buildFunctionSignature(entry, false);
  const typeParameters =
    signature.typeParameters.length > 0 ? signature.typeParameters : undefined;

  return ts.factory.createMethodDeclaration(
    isStatic
      ? [ts.factory.createModifier(ts.SyntaxKind.StaticKeyword)]
      : undefined,
    undefined,
    toPropertyName(entry.name),
    undefined,
    typeParameters,
    signature.parameters,
    signature.returnType,
    undefined,
  );
}

function buildPropertyDeclaration(entry: MetaFieldEntry): ts.ClassElement {
  const typeNode = entry.typ
    ? createTypeNodeFromText(entry.typ)
    : ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);

  if (/^\[(string|number)\]$/.test(entry.name)) {
    const indexType =
      entry.name === "[number]"
        ? ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword)
        : ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
    const parameter = ts.factory.createParameterDeclaration(
      undefined,
      undefined,
      "key",
      undefined,
      indexType,
      undefined,
    );

    return ts.factory.createIndexSignature(undefined, [parameter], typeNode);
  }

  const name = toPropertyName(entry.name);

  return ts.factory.createPropertyDeclaration(
    undefined,
    name,
    undefined,
    typeNode,
    undefined,
  );
}

function buildCallablePropertyDeclaration(
  fieldEntry: MetaFieldEntry,
  fnEntries: MetaFnEntry[],
): ts.ClassElement {
  // If any of the function entries are non-methods, treat the property as `static`.
  const fieldType = fieldEntry.typ
    ? buildFieldTypeNode(fieldEntry.typ, [])
    : ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
  // Callable signatures inside classes should include `this: void` when JSON indicates non-methods.
  const callableTypes = fnEntries.map((entry) =>
    buildFunctionTypeNode(entry, shouldEmitThisVoidParameter(entry)),
  );
  const typeNode = ts.factory.createIntersectionTypeNode([
    fieldType,
    ...callableTypes,
  ]);
  const isStatic = fnEntries.some((entry) => entry.is_meth === false);
  const modifiers = isStatic
    ? [ts.factory.createModifier(ts.SyntaxKind.StaticKeyword)]
    : undefined;

  return ts.factory.createPropertyDeclaration(
    modifiers,
    toPropertyName(fieldEntry.name),
    undefined,
    typeNode,
    undefined,
  );
}

function buildFunctionDeclaration(entry: MetaFnEntry): ts.FunctionDeclaration {
  const signature = buildFunctionSignature(
    entry,
    shouldEmitThisVoidParameter(entry),
  );

  return ts.factory.createFunctionDeclaration(
    [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
    undefined,
    toValidTopLevelName(entry.name),
    signature.typeParameters.length > 0 ? signature.typeParameters : undefined,
    signature.parameters,
    signature.returnType,
    undefined,
  );
}

function buildFunctionDeclarationFromField(
  entry: MetaFieldEntry,
  warnings: string[],
): ts.FunctionDeclaration {
  if (!entry.typ || !isFunctionType(entry.typ)) {
    throw new Error(`Expected function type for ${entry.name}`);
  }

  const signature = buildFunctionSignatureFromTypeText(
    entry.typ,
    warnings,
    true,
  );

  return ts.factory.createFunctionDeclaration(
    [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
    undefined,
    toValidTopLevelName(entry.name),
    signature.typeParameters.length > 0 ? signature.typeParameters : undefined,
    signature.parameters,
    signature.returnType,
    undefined,
  );
}

function buildFunctionTypeNode(
  entry: MetaFnEntry,
  includeThisVoidParameter: boolean,
): ts.FunctionTypeNode {
  const signature = buildFunctionSignature(entry, includeThisVoidParameter);

  return ts.factory.createFunctionTypeNode(
    signature.typeParameters.length > 0 ? signature.typeParameters : undefined,
    signature.parameters,
    signature.returnType,
  );
}

function createFunctionTypeNodeFromFieldEntry(
  entry: MetaFieldEntry,
  warnings: string[],
): ts.TypeNode {
  if (!entry.typ || !isFunctionType(entry.typ)) {
    throw new Error(`Expected function type for ${entry.name}`);
  }

  const signature = buildFunctionSignatureFromTypeText(
    entry.typ,
    warnings,
    true,
  );

  return ts.factory.createFunctionTypeNode(
    signature.typeParameters.length > 0 ? signature.typeParameters : undefined,
    signature.parameters,
    signature.returnType,
  );
}

function buildConstDeclaration(
  name: string,
  entry: MetaFieldEntry,
  warnings: string[],
  customName?: string,
): ts.VariableStatement {
  const typeNode = entry.typ
    ? buildFieldTypeNode(entry.typ, warnings)
    : ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);

  return withCustomNameComment(
    ts.factory.createVariableStatement(
      [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
      ts.factory.createVariableDeclarationList(
        [
          ts.factory.createVariableDeclaration(
            ts.factory.createIdentifier(name),
            undefined,
            typeNode,
            undefined,
          ),
        ],
        ts.NodeFlags.Const,
      ),
    ),
    customName,
  );
}

function createCustomNamedVariableStatement(
  name: string,
  typeNode: ts.TypeNode,
  customName: string,
): ts.VariableStatement {
  return withCustomNameComment(
    ts.factory.createVariableStatement(
      [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
      ts.factory.createVariableDeclarationList(
        [
          ts.factory.createVariableDeclaration(
            ts.factory.createIdentifier(name),
            undefined,
            typeNode,
            undefined,
          ),
        ],
        ts.NodeFlags.Const,
      ),
    ),
    customName,
  );
}

function buildFunctionSignature(
  entry: MetaFnEntry,
  includeThisVoidParameter: boolean,
): FunctionSignatureSpec {
  const typeParameters = buildFunctionTypeParameters(entry.generics ?? []);
  const parameters = [
    ...(includeThisVoidParameter ? [createThisVoidParameter()] : []),
    ...(entry.params ?? []).map((param) => buildParameterDeclaration(param)),
  ];
  const returnType = buildReturnType(entry.returns ?? []);

  return { typeParameters, parameters, returnType };
}

function buildFunctionSignatureFromTypeText(
  typeText: string,
  warnings: string[],
  includeThisVoidParameter: boolean,
): FunctionSignatureSpec {
  const parsed = parseFunctionTypeText(
    typeText,
    warnings,
    includeThisVoidParameter,
  );

  return parsed;
}

function buildFunctionTypeParameters(
  entries: Array<string | MetaGenericEntry>,
): ts.TypeParameterDeclaration[] {
  return entries.map((entry) => buildTypeParameterDeclaration(entry));
}

function buildParameterDeclaration(
  param: MetaFnParam,
): ts.ParameterDeclaration {
  const cleanedName = param.name.replace(/\?$/, "");
  const isRest = cleanedName.startsWith("...");
  const identifier = isRest ? cleanedName.slice(3) || "args" : cleanedName;
  const typeNode = param.typ
    ? createTypeNodeFromText(param.typ)
    : ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
  const finalTypeNode = isRest
    ? ts.factory.createArrayTypeNode(typeNode)
    : typeNode;

  return ts.factory.createParameterDeclaration(
    undefined,
    isRest ? ts.factory.createToken(ts.SyntaxKind.DotDotDotToken) : undefined,
    toValidParameterName(identifier),
    param.name.endsWith("?")
      ? ts.factory.createToken(ts.SyntaxKind.QuestionToken)
      : undefined,
    finalTypeNode,
    undefined,
  );
}

function createThisVoidParameter(): ts.ParameterDeclaration {
  return ts.factory.createParameterDeclaration(
    undefined,
    undefined,
    ts.factory.createIdentifier("this"),
    undefined,
    ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
    undefined,
  );
}

function buildReturnType(returns: MetaFnReturn[]): ts.TypeNode {
  if (returns.length === 0) {
    return ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
  }

  if (returns.length === 1) {
    const first = returns[0];
    return first?.typ
      ? createTypeNodeFromText(first.typ)
      : ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
  }

  return ts.factory.createTypeReferenceNode("LuaMultiReturn", [
    ts.factory.createTupleTypeNode(
      returns.map((item) =>
        item.typ
          ? createTypeNodeFromText(item.typ)
          : ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
      ),
    ),
  ]);
}

function parseFunctionTypeText(
  typeText: string,
  warnings: string[],
  includeThisVoidParameter: boolean,
): FunctionSignatureSpec {
  const match = LUA_FUNCTION_RE.exec(typeText.trim());

  if (!match?.groups) {
    throw new Error(`Cannot parse function type: ${typeText}`);
  }

  const genericText = match.groups.generics?.trim() ?? "";
  const paramsText = match.groups.params?.trim() ?? "";
  const returnsText = match.groups.returns?.trim() ?? "";

  const typeParameters =
    genericText.length > 0
      ? genericText
          .split(",")
          .map((name) => buildTypeParameterDeclaration(name.trim()))
      : [];
  const parameters = [
    ...(includeThisVoidParameter ? [createThisVoidParameter()] : []),
    ...(paramsText.length > 0
      ? splitTopLevel(paramsText, ",").map((paramText) =>
          buildParameterFromFunctionTypeParam(paramText.trim(), warnings),
        )
      : []),
  ];
  const returnType =
    returnsText.length > 0
      ? createTypeNodeFromText(normalizeLuaTypeText(returnsText, warnings))
      : ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);

  return { typeParameters, parameters, returnType };
}

function buildParameterFromFunctionTypeParam(
  paramText: string,
  warnings: string[],
): ts.ParameterDeclaration {
  const cleaned = paramText.replace(/\.{3,}/g, "...").trim();

  if (cleaned.startsWith("...")) {
    const restTypeText = cleaned.includes(":")
      ? cleaned.slice(cleaned.indexOf(":") + 1).trim()
      : "any";
    return ts.factory.createParameterDeclaration(
      undefined,
      ts.factory.createToken(ts.SyntaxKind.DotDotDotToken),
      ts.factory.createIdentifier("args"),
      undefined,
      ts.factory.createArrayTypeNode(
        createTypeNodeFromText(normalizeLuaTypeText(restTypeText, warnings)),
      ),
      undefined,
    );
  }

  const colonIndex = cleaned.indexOf(":");
  if (colonIndex === -1) {
    return ts.factory.createParameterDeclaration(
      undefined,
      undefined,
      ts.factory.createIdentifier(toValidParameterName(cleaned)),
      undefined,
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
      undefined,
    );
  }

  const rawName = cleaned.slice(0, colonIndex).trim();
  const rawType = cleaned.slice(colonIndex + 1).trim();
  const isOptional = rawName.endsWith("?");
  const name = rawName.replace(/\?$/, "");

  return ts.factory.createParameterDeclaration(
    undefined,
    undefined,
    ts.factory.createIdentifier(toValidParameterName(name)),
    isOptional
      ? ts.factory.createToken(ts.SyntaxKind.QuestionToken)
      : undefined,
    createTypeNodeFromText(normalizeLuaTypeText(rawType, warnings)),
    undefined,
  );
}

function normalizeLuaTypeText(typeText: string, warnings: string[]): string {
  const trimmed = typeText.trim();

  if (trimmed.startsWith("fun")) {
    return normalizeFunctionTypeText(trimmed, warnings);
  }

  let normalized = trimmed;
  normalized = normalized.replace(/\binteger\b/g, "number");
  normalized = normalized.replace(/\bnil\b/g, "undefined");
  normalized = normalized.replace(/\bvoid\b/g, "void");
  normalized = normalized.replace(/\bany\b/g, "any");
  normalized = normalized.replace(/\btable<([^>]+)>/g, (_, inner: string) => {
    const parts = splitTopLevel(inner, ",");
    if (parts.length === 1) {
      const [valueText] = parts;
      return `Record<string, ${valueText?.trim() ?? "any"}>`;
    }

    const [keyText, valueText] = parts;
    return `Record<${keyText?.trim() ?? "string"}, ${valueText?.trim() ?? "any"}>`;
  });
  normalized = normalized.replace(
    /([^\w])([A-Za-z_][A-Za-z0-9_]*\?)\b/g,
    (_match, prefix: string, typeName: string) =>
      `${prefix}${typeName.replace(/\?$/, "")} | undefined`,
  );

  return normalized;
}

function normalizeFunctionTypeText(
  typeText: string,
  warnings: string[],
): string {
  const match = LUA_FUNCTION_RE.exec(typeText.trim());

  if (!match?.groups) {
    return typeText;
  }

  const genericText = match.groups.generics?.trim() ?? "";
  const paramsText = match.groups.params?.trim() ?? "";
  const returnsText = match.groups.returns?.trim() ?? "";
  const genericPrefix = genericText.length > 0 ? `<${genericText}>` : "";
  const parameterText =
    paramsText.length > 0
      ? splitTopLevel(paramsText, ",")
          .map((paramText) =>
            normalizeFunctionParameterText(paramText.trim(), warnings),
          )
          .join(", ")
      : "";
  const returnText =
    returnsText.length > 0
      ? normalizeLuaTypeText(returnsText, warnings)
      : "void";

  return `${genericPrefix}(${parameterText}) => ${returnText}`;
}

function normalizeFunctionParameterText(
  paramText: string,
  warnings: string[],
): string {
  const cleaned = paramText.replace(/\.{3,}/g, "...").trim();

  if (cleaned.startsWith("...")) {
    const restTypeText = cleaned.includes(":")
      ? cleaned.slice(cleaned.indexOf(":") + 1).trim()
      : "any";
    return `...args: ${normalizeLuaTypeText(restTypeText, warnings)}[]`;
  }

  const colonIndex = cleaned.indexOf(":");
  if (colonIndex === -1) {
    return `${toValidParameterName(cleaned)}: any`;
  }

  const rawName = cleaned.slice(0, colonIndex).trim().replace(/\?$/, "");
  const rawType = cleaned.slice(colonIndex + 1).trim();
  const optional = cleaned.slice(0, colonIndex).trim().endsWith("?");

  return `${toValidParameterName(rawName)}${optional ? "?" : ""}: ${normalizeLuaTypeText(rawType, warnings)}`;
}

function createTypeNodeFromText(typeText: string): ts.TypeNode {
  const normalized = normalizeLuaTypeText(typeText, []);
  const finalized = collectUnresolvedTypeNames(normalized);
  const sourceFile = ts.createSourceFile(
    "generated-type.ts",
    `type __T = ${finalized};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statement = sourceFile.statements[0];

  if (!statement || !ts.isTypeAliasDeclaration(statement)) {
    throw new Error(`Unable to parse type node: ${typeText}`);
  }

  return statement.type;
}

function collectUnresolvedTypeNames(typeText: string): string {
  const context = activeTypeResolutionContext;
  if (!context) {
    return typeText;
  }

  if (context.mode === "any-all") {
    return typeText.replace(
      QUALIFIED_UNRESOLVED_TYPE_RE,
      (match, name: string, offset: number, fullText: string) => {
        if (!isUnresolvedQualifiedType(name, offset, fullText, context)) {
          return match;
        }

        context.unresolvedTypeNames.add(name);
        if (!context.warnedUnresolvedNames.has(name)) {
          context.warnedUnresolvedNames.add(name);
          context.warnings.push(
            `Unresolved type '${name}' encountered; replaced with 'any' due to --unresolved-type any-all.`,
          );
        }

        return "any";
      },
    );
  }

  return typeText.replace(
    BARE_UNRESOLVED_TYPE_RE,
    (match, name: string, offset: number, fullText: string) => {
      if (!isUnresolvedBareType(name, offset, fullText, context)) {
        return match;
      }

      context.unresolvedTypeNames.add(name);

      if (context.mode === "any" || context.mode === "any-bare") {
        if (!context.warnedUnresolvedNames.has(name)) {
          context.warnedUnresolvedNames.add(name);
          context.warnings.push(
            `Unresolved bare type '${name}' encountered; replaced with 'any' due to --unresolved-type any.`,
          );
        }
        return "any";
      }

      if (context.mode === "alias-any") {
        context.unresolvedAliasNames.add(name);
        if (!context.warnedUnresolvedNames.has(name)) {
          context.warnedUnresolvedNames.add(name);
          context.warnings.push(
            `Unresolved bare type '${name}' encountered; preserving name and emitting 'declare type ${name} = any'.`,
          );
        }
        return name;
      }

      return name;
    },
  );
}

function isUnresolvedQualifiedType(
  name: string,
  offset: number,
  fullText: string,
  context: TypeResolutionContext,
): boolean {
  if (name.length <= 1) {
    return false;
  }

  const rootName = name.split(".")[0] ?? name;
  if (
    !rootName ||
    context.knownTypeNames.has(rootName) ||
    KNOWN_BUILTIN_TYPE_NAMES.has(rootName)
  ) {
    return false;
  }

  const prevChar = offset > 0 ? fullText[offset - 1] : "";
  const nextChar =
    offset + name.length < fullText.length
      ? fullText[offset + name.length]
      : "";

  if (prevChar === "." || nextChar === ".") {
    return false;
  }

  return true;
}

function isUnresolvedBareType(
  name: string,
  offset: number,
  fullText: string,
  context: TypeResolutionContext,
): boolean {
  if (name.length <= 1) {
    return false;
  }

  if (context.knownTypeNames.has(name) || KNOWN_BUILTIN_TYPE_NAMES.has(name)) {
    return false;
  }

  const prevChar = offset > 0 ? fullText[offset - 1] : "";
  const nextChar =
    offset + name.length < fullText.length
      ? fullText[offset + name.length]
      : "";

  // Skip qualified names like VFramework.UI.Button and UnityEngine.Collider.
  if (prevChar === "." || nextChar === ".") {
    return false;
  }

  return true;
}

function splitTopLevel(text: string, separator: string): string[] {
  const result: string[] = [];
  let depthAngle = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let current = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === "<") {
      depthAngle += 1;
    } else if (char === ">") {
      depthAngle = Math.max(0, depthAngle - 1);
    } else if (char === "(") {
      depthParen += 1;
    } else if (char === ")") {
      depthParen = Math.max(0, depthParen - 1);
    } else if (char === "[") {
      depthBracket += 1;
    } else if (char === "]") {
      depthBracket = Math.max(0, depthBracket - 1);
    } else if (char === "{") {
      depthBrace += 1;
    } else if (char === "}") {
      depthBrace = Math.max(0, depthBrace - 1);
    }

    if (
      char === separator &&
      depthAngle === 0 &&
      depthParen === 0 &&
      depthBracket === 0 &&
      depthBrace === 0
    ) {
      result.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) {
    result.push(current.trim());
  }

  return result;
}

function isFunctionType(typeText: string | undefined): boolean {
  return typeText?.trim().startsWith("fun") ?? false;
}

function buildFieldTypeNode(typeText: string, warnings: string[]): ts.TypeNode {
  if (isFunctionType(typeText)) {
    return createTypeNodeFromText(
      normalizeFunctionTypeText(typeText, warnings),
    );
  }

  return createTypeNodeFromText(typeText);
}

function getLine(entry: { loc?: MetaLoc | MetaLoc[] | null }): number {
  if (Array.isArray(entry.loc)) {
    return entry.loc[0]?.line ?? Number.POSITIVE_INFINITY;
  }

  return entry.loc?.line ?? Number.POSITIVE_INFINITY;
}

function groupByName<T extends { name: string }>(
  entries: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const entry of entries) {
    const group = groups.get(entry.name);
    if (group) {
      group.push(entry);
      continue;
    }

    groups.set(entry.name, [entry]);
  }

  return groups;
}

async function resolveJsonPath(options: {
  metaFile: string;
  sourceRoot: string;
  jsonRoot: string | undefined;
}): Promise<string> {
  if (!options.jsonRoot) {
    return options.metaFile.replace(/\.lua$/i, ".json");
  }

  const jsonStat = await fs.stat(options.jsonRoot);
  if (jsonStat.isDirectory()) {
    const relativeMetaPath = path.relative(
      options.sourceRoot,
      options.metaFile,
    );
    return path.join(options.jsonRoot, relativeMetaPath.replace(/\.lua$/i, ".json"));
  }

  return path.resolve(options.jsonRoot);
}

function toValidTypeName(name: string): string {
  return isValidTopLevelName(name) ? name : mangleTopLevelName(name);
}

function toPropertyName(name: string): ts.PropertyName {
  if (/^\d+$/.test(name)) {
    return ts.factory.createNumericLiteral(name);
  }

  if (/^\[\d+\]$/.test(name)) {
    return ts.factory.createNumericLiteral(name.slice(1, -1));
  }

  return isValidPropertyName(name)
    ? ts.factory.createIdentifier(name)
    : ts.factory.createStringLiteral(name);
}

function toValidTopLevelName(name: string): string {
  return isValidTopLevelName(name) ? name : mangleTopLevelName(name);
}

function toValidParameterName(name: string): string {
  return isValidPropertyName(name)
    ? name
    : `_${name.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function shouldEmitThisVoidParameter(entry: MetaFnEntry): boolean {
  return entry.is_meth !== true;
}

function isValidPropertyName(name: string): boolean {
  return (
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) &&
    !RESERVED_TOP_LEVEL_NAMES.has(name)
  );
}

function isValidTopLevelName(name: string): boolean {
  return isValidPropertyName(name);
}

function mangleTopLevelName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  return sanitized.length > 0 ? `${sanitized}_` : "generated_";
}

function withCustomNameComment<T extends ts.Node>(
  node: T,
  customName: string | undefined,
): T {
  if (!customName || !isCustomNameSafe(customName)) {
    return node;
  }

  return ts.addSyntheticLeadingComment(
    node,
    ts.SyntaxKind.MultiLineCommentTrivia,
    `* @customName ${customName} `,
    true,
  );
}

function isCustomNameSafe(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

async function walkDirectory(
  directory: string,
  files: string[],
): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(resolved, files);
      continue;
    }

    if (entry.isFile()) {
      files.push(resolved);
    }
  }
}
