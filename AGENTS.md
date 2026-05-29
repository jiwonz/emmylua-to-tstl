# AGENTS.md

Repository guidance for coding agents working in this workspace.

## Package manager

- Prefer `pnpm` for all dependency and script commands in this repo.
- Do not introduce `npm` commands in docs, scripts, or instructions unless explicitly requested.
- This repo includes `pnpm-lock.yaml` and `pnpm-workspace.yaml`; treat that as authoritative.

## Command conventions

- Use existing scripts from `package.json` when available.
- Preferred command examples:
  - `pnpm install`
  - `pnpm build`
  - `pnpm test`
  - `pnpm check`

## Type generation policy reminders

- Keep `emmylua_doc_cli` JSON as the source of truth.
- Preserve class-member semantics:
  - `is_meth: true` -> instance methods
  - `is_meth: false` -> static members
- Respect unresolved type mode options:
  - `strict`
  - `nonstrict`
  - `any`
  - `alias-any`

## Safety and editing

- Prefer minimal diffs and avoid unrelated refactors.
- Do not regenerate sample outputs unless needed for verification.
- Run tests after changing generator behavior.

## Agent execution environment

- When running shell/terminal commands, avoid embedding control characters (for example `^U` or other non-printable prefixes) before commands. These can be interpreted literally by PowerShell and other shells and will cause failures.
- Prefer PowerShell-safe command forms for this repository's environment (Windows): use `;` to separate commands or run separate commands rather than using shell-specific `&&` chaining.
- When showing commands to the user, present them explicitly and verbatim so they can copy/paste into their shell.
- If an agent must execute commands programmatically, ensure the command string is sanitized to remove control characters and is compatible with PowerShell.
