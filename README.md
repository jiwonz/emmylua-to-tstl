# emmylua-to-tstl

A simple CLI to generate TypeScript ambient declarations (.d.ts) from EmmyLua `.lua` metadata (and accompanying JSON produced by `emmylua_doc_cli`), useful alongside TypeScript→Lua toolchains such as [TSTL](https://typescripttolua.github.io/).

## Why? What you can do with it?

If your Lua development environment supports EmmyLua annotations, you can use this tool to generate TypeScript declaration files that can be consumed by TypeScript→Lua transpilers like TSTL.

This allows you to write your Lua code with rich type information and have it available in TypeScript for better type checking and editor support.

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

```bash
# emit one .d.ts per input `.lua` under `dist/typings`
pnpm exec emmylua-to-tstl sample --out-dir dist/typings

# include/exclude examples
pnpm exec emmylua-to-tstl sample --include "**/core/*.lua" --exclude "**/test-*.lua" --out-dir dist/typings
```

## Configuration

- `--out <file>`: output `.d.ts` file (defaults to stdout)
- `-o <file>`: short alias for `--out`
- `--unresolved-type <mode>`: `strict|nonstrict|any|alias-any|any-bare|any-all` (default: `nonstrict`)
 - `--no-check`: Prefix generated .d.ts with `// @ts-nocheck` to disable TS checking.
 - `--out <file>`: output `.d.ts` file (defaults to stdout)
 - `-o <file>`: short alias for `--out`
 - `--out-dir <dir>`: emit one `.d.ts` per input `.lua` under `<dir>` (preserves relative paths)
 - `--include <glob>`: include only files matching the glob (may be repeated)
 - `--exclude <glob>`: exclude files matching the glob (may be repeated)
 - `--unresolved-type <mode>`: `strict|nonstrict|any|alias-any|any-bare|any-all` (default: `nonstrict`)

## Unresolved type modes

- `strict`: stop with an error if the source contains unresolved type names.
- `nonstrict`: keep unresolved names as-is.
- `any`: replace unresolved bare type names with `any`.
- `alias-any`: keep unresolved names, then emit `declare type Name = any;` for them.
- `any-bare`: same as `any` for bare unresolved names.
- `any-all`: replace unresolved bare and qualified type names with `any`.

## Notes

- The tool reads `.meta.lua` files or directories containing them.
- Warnings are printed to stderr; generated declarations go to stdout or the `--out` file.
 - The tool reads `.lua` files or directories containing them (recursively). For each `X.lua` it expects `X.json` next to it (or will run `emmylua_doc_cli` to generate JSON when needed).
 - When a directory is provided, the tool recursively discovers `.lua` files; use `--include`/`--exclude` to restrict selection.
 - Warnings are printed to stderr; generated declarations go to stdout, the `--out` file, or per-file under `--out-dir`.

## Development

We use `mise` to manage tools and versions. After cloning, run `mise install` to set up the environment.

## License

MIT
