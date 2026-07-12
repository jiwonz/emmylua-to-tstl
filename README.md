# emmylua-to-tstl

A simple CLI to generate TypeScript ambient declarations (.d.ts) from EmmyLua `.lua` metadata (and accompanying JSON produced by `emmylua_doc_cli`), useful alongside TypeScript→Lua toolchains such as [TSTL](https://typescripttolua.github.io/).

This package can also be used directly as a JavaScript/TypeScript library.

## Why? What you can do with it?

If your Lua development environment supports EmmyLua annotations, you can use this tool to generate TypeScript declaration files that can be consumed by TypeScript→Lua transpilers like TSTL.

This allows you to write your Lua code with rich type information and have it available in TypeScript for better type checking and editor support.

Basically, you can write your code in TypeScript if your Lua environment supports EmmyLua.

## Install

Requires [`emmylua_doc_cli`](https://github.com/EmmyLuaLs/emmylua-analyzer-rust/releases) on `PATH`.

```bash
pnpm add -D emmylua-to-tstl
```

## Quick CLI usage

```bash
# write to stdout
pnpm exec emmylua-to-tstl sample

# write to file
pnpm exec emmylua-to-tstl sample --out typings/example_types.d.ts --unresolved-type any-all

	# write to file and disable TypeScript checking in the emitted file
	pnpm exec emmylua-to-tstl sample --out typings/example_types.d.ts --no-check

# same output flag using the short alias
pnpm exec emmylua-to-tstl sample -o typings/example_types.d.ts
```

## Library usage (JS/TS)

```ts
import {
	collectMetaFiles,
	generateDeclarations,
	generateDeclarationsPerFile,
} from "emmylua-to-tstl";

const files = await collectMetaFiles("sample");

const combined = await generateDeclarations({
	sourcePath: "sample",
	jsonPath: undefined,
	outPath: undefined,
	unresolvedTypeMode: "nonstrict",
});

const perFile = await generateDeclarationsPerFile({
	sourcePath: "sample",
	jsonPath: undefined,
	outPath: undefined,
	outDir: "typings",
	unresolvedTypeMode: "nonstrict",
});

console.log(files.length, combined.warnings.length, perFile.length);
```

## API reference

### `collectMetaFiles(inputPath, includePatterns?, excludePatterns?)`

Discover `.lua` metadata files from a single file path or by recursively scanning a directory.

- `inputPath: string`: Source file or directory.
- `includePatterns?: string[]`: Optional glob filters to include only matching relative paths.
- `excludePatterns?: string[]`: Optional glob filters to remove matching relative paths.

Returns: `Promise<string[]>` sorted absolute file paths.

### `generateDeclarations(options)`

Generate one combined declaration output from all discovered inputs.

- `options.sourcePath: string`: Source file or directory.
- `options.jsonPath?: string`: Optional JSON file or JSON root directory.
- `options.outPath?: string`: Optional output file path (used by CLI flows).
- `options.outDir?: string`: Optional output directory (used by CLI flows).
- `options.includePatterns?: string[]`: Optional include globs.
- `options.excludePatterns?: string[]`: Optional exclude globs.
- `options.unresolvedTypeMode?`: Handling mode for unresolved types.
- `options.noCheck?: boolean`: Add `// @ts-nocheck` to generated output.

Returns: `Promise<{ text: string; warnings: string[] }>`.

### `generateDeclarationsPerFile(options)`

Generate one declaration output per source `.lua` file.

Uses the same `options` shape as `generateDeclarations`.

Returns: `Promise<Array<{ relativePath: string; text: string; warnings: string[] }>>`.

### `runCli(argv)`

Programmatic CLI entrypoint if you want CLI behavior from code.

- `argv: string[]`: CLI arguments (equivalent to `process.argv.slice(2)`).

Returns: `Promise<number>` exit code.

### `UnresolvedTypeMode`

Allowed values:

- `strict`
- `nonstrict` (default)
- `any`
- `unknown`
- `alias-any`
- `any-bare`
- `any-all`

```bash
# emit one .d.ts per input `.lua` under `dist/typings`
pnpm exec emmylua-to-tstl sample --out-dir dist/typings

# include/exclude examples
pnpm exec emmylua-to-tstl sample --include "**/core/*.lua" --exclude "**/test-*.lua" --out-dir dist/typings
```

## Configuration

- `--out <file>`: output `.d.ts` file (defaults to stdout)
- `-o <file>`: short alias for `--out`
- `--unresolved-type <mode>`: `strict|nonstrict|any|unknown|alias-any|any-bare|any-all` (default: `nonstrict`)
 - `--no-check`: Prefix generated .d.ts with `// @ts-nocheck` to disable TS checking.
 - `--out <file>`: output `.d.ts` file (defaults to stdout)
 - `-o <file>`: short alias for `--out`
 - `--out-dir <dir>`: emit one `.d.ts` per input `.lua` under `<dir>` (preserves relative paths)
 - `--include <glob>`: include only files matching the glob (may be repeated)
 - `--exclude <glob>`: exclude files matching the glob (may be repeated)
 - `--unresolved-type <mode>`: `strict|nonstrict|any|unknown|alias-any|any-bare|any-all` (default: `nonstrict`)

## Unresolved type modes

- `strict`: stop with an error if the source contains unresolved type names.
- `nonstrict`: keep unresolved names as-is.
- `any`: replace unresolved bare type names with `any`.
- `unknown`: replace unresolved type names with `unknown` to force explicit narrowing or casting.
- `alias-any`: keep unresolved names, then emit `declare type Name = any;` for them.
- `any-bare`: same as `any` for bare unresolved names.
- `any-all`: replace unresolved bare and qualified type names with `any`.

## Notes

- The tool reads `.meta.lua` files or directories containing them.
- Warnings are printed to stderr; generated declarations go to stdout or the `--out` file.
 - The tool reads `.lua` files or directories containing them (recursively). For each `X.lua` it expects `X.json` next to it (or will run `emmylua_doc_cli` to generate JSON when needed).
 - When a directory is provided, the tool recursively discovers `.lua` files; use `--include`/`--exclude` to restrict selection.
 - Warnings are printed to stderr; generated declarations go to stdout, the `--out` file, or per-file under `--out-dir`.
- This tool was written with AI assistance, so expect some weird code and edge cases. Please report issues or submit PRs if you have improvements!

## Development

We use `mise` to manage tools and versions. After cloning, run `mise install` to set up the environment.

## License

MIT
