# EVOLVE

EVOLVE is a Cursor-only v1 CLI and daemon for safely evolving local agent assets over time.

It reads Cursor conversation metadata and supported Cursor file surfaces, creates evidence
cards, asks Cursor SDK specialist agents for proposals when `CURSOR_API_KEY` is available,
validates those proposals conservatively, applies only approved changes with exact backups,
and writes pre/post snapshots plus deep diffs for every epoch.

V1 intentionally does not read or mutate Codex or Claude paths.

## Quick Start

```bash
pnpm install
pnpm build
pnpm evolve init --systems cursor --yes
pnpm evolve snapshot create --label before-manual
pnpm evolve run --once
pnpm evolve snapshot create --label after-manual
pnpm evolve diff before-manual after-manual
```

State is stored under `~/.evolve`.
