# emmylua-to-tstl

A simple CLI to generate TypeScript ambient declarations (.d.ts) from EmmyLua `.meta.lua` metadata, useful alongside TypeScript→Lua toolchains such as [TSTL](https://typescripttolua.github.io/).

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

# same output flag using the short alias
pnpm exec emmylua-to-tstl sample -o typings/example_types.d.ts
```

## Configuration

- `--out <file>`: output `.d.ts` file (defaults to stdout)
- `-o <file>`: short alias for `--out`
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

## Development

We use `mise` to manage tools and versions. After cloning, run `mise install` to set up the environment.

## License

MIT
