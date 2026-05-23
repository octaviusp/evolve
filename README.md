```text
███████╗██╗   ██╗ ██████╗ ██╗     ██╗   ██╗███████╗
██╔════╝██║   ██║██╔═══██╗██║     ██║   ██║██╔════╝
█████╗  ██║   ██║██║   ██║██║     ██║   ██║█████╗
██╔══╝  ╚██╗ ██╔╝██║   ██║██║     ╚██╗ ██╔╝██╔══╝
███████╗ ╚████╔╝ ╚██████╔╝███████╗ ╚████╔╝ ███████╗
╚══════╝  ╚═══╝   ╚═════╝ ╚══════╝  ╚═══╝  ╚══════╝
```

# EVOLVE

EVOLVE is a TypeScript CLI for autonomous agent evolution.

Today it is **Cursor-only**. It scans Cursor conversations and managed Cursor
agent assets, builds compact evidence, asks Cursor SDK agents for improvement
proposals, validates them strictly, applies only safe EVOLVE-managed changes,
and writes pre/post snapshots with rollback data.

## Install

```bash
pnpm install
pnpm build
```

## Use

```bash
pnpm evolve init --systems cursor --yes
pnpm evolve doctor
pnpm evolve run --once
```

Runtime state lives in `~/.evolve`. Cursor outputs are written only to managed
Cursor surfaces such as `~/.cursor/skills/evolve/*`, `~/.cursor/agents/evolve-*`,
and `~/.cursor/rules/evolve-*`.
