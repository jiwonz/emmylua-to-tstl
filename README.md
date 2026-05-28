# emmylua-to-tstl

Lightweight CLI to generate TypeScript ambient declarations (.d.ts) from EmmyLua `.meta.lua` metadata (consumes `emmylua_doc_cli` JSON); useful alongside TypeScript→Lua toolchains such as TSTL.

## Install

```bash
pnpm add -D emmylua-to-tstl
```

## Quick CLI usage

```bash
# write to stdout
pnpm exec emmylua-to-tstl sample

# write to file
pnpm exec emmylua-to-tstl sample --json sample --out typings/example_types.d.ts --unresolved-type any-all
```

## Configuration

- `--json <path>`: path to emmylua_doc_cli JSON (file or dir)
- `--out <file>`: output `.d.ts` file (defaults to stdout)
- `--unresolved-type <mode>`: `strict|nonstrict|any|alias-any|any-bare|any-all`

## Notes

- The tool reads the `.meta.lua` filenames and consumes the corresponding `emmylua_doc_cli` JSON — it does not parse raw Lua source.
- Warnings are printed to stderr; generated declarations go to stdout or the `--out` file.

## Development

We use `mise` to manage tools and versions. After cloning, run `mise install` to set up the environment.

## License

MIT
