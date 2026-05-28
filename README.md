# emmylua-to-tstl

`emmylua-to-tstl` converts EmmyLua meta Lua files plus `emmylua_doc_cli` JSON output into global TypeScript declaration files for TSTL-oriented projects.

It uses the JSON for class and member declarations, then scans the meta Lua source for top-level helper functions that the JSON does not surface.

## Usage

```powershell
pnpm build
node dist/index.js sample --out sample/vgf_types.d.ts
```

If you already have a single `.meta.lua` file and its JSON companion, you can point the CLI at the file instead of the folder:

```powershell
node dist/index.js sample/vgf_types.meta.lua --json sample/vgf_types.json
```

## Unresolved types

The CLI supports `--unresolved-type` to control how unresolved type names that cannot be resolved from the JSON are handled:

- `strict`: fail the conversion and report the unresolved names
- `nonstrict`: keep the unresolved names in the generated `.d.ts`
- `any`: replace unresolved bare names with `any`
- `alias-any`: keep the unresolved names and emit `declare type Name = any` aliases
- `any-bare`: same as `any`
- `any-all`: replace unresolved bare and qualified names with `any`

Examples:

```powershell
node dist/index.js sample --out sample/vgf_types.d.ts --unresolved-type strict
node dist/index.js sample --out sample/vgf_types.d.ts --unresolved-type nonstrict
node dist/index.js sample --out sample/vgf_types.d.ts --unresolved-type any
node dist/index.js sample --out sample/vgf_types.d.ts --unresolved-type alias-any
node dist/index.js sample --out sample/vgf_types.d.ts --unresolved-type any-bare
node dist/index.js sample --out sample/vgf_types.d.ts --unresolved-type any-all
```

## Input format

The tool expects the JSON produced by `emmylua_doc_cli` alongside the original meta Lua file. It emits ambient declarations for:

- classes
- class fields and methods
- global functions
- global constants and function-valued fields

Identifiers that are not valid TypeScript globals are normalized to safe names. For example, a Lua helper named `typeof` is emitted as `typeof_`.

## Development

```powershell
pnpm install
pnpm build
pnpm check
```

The repository includes a sample pair under `sample/` that you can use as a reference input.
