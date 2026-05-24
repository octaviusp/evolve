import chalk from "chalk";

export type CheckLevel = "ok" | "warn" | "error" | "info";

export interface RenderCheck {
  level: CheckLevel;
  label: string;
  detail: string;
}

const SYMBOLS: Record<CheckLevel, string> = {
  ok: "✓",
  warn: "!",
  error: "×",
  info: "•",
};

const COLORS: Record<CheckLevel, (text: string) => string> = {
  ok: chalk.green,
  warn: chalk.yellow,
  error: chalk.red,
  info: chalk.cyan,
};

export function renderLogo(): string {
  return [
    chalk.cyan("███████╗██╗   ██╗ ██████╗ ██╗     ██╗   ██╗███████╗"),
    chalk.cyan("██╔════╝██║   ██║██╔═══██╗██║     ██║   ██║██╔════╝"),
    chalk.cyan("█████╗  ██║   ██║██║   ██║██║     ██║   ██║█████╗  "),
    chalk.cyan("██╔══╝  ╚██╗ ██╔╝██║   ██║██║     ╚██╗ ██╔╝██╔══╝  "),
    chalk.cyan("███████╗ ╚████╔╝ ╚██████╔╝███████╗ ╚████╔╝ ███████╗"),
    chalk.cyan("╚══════╝  ╚═══╝   ╚═════╝ ╚══════╝  ╚═══╝  ╚══════╝"),
    chalk.gray("multi-system agent evolution — cursor · claude · codex"),
  ].join("\n");
}

export function renderChecks(title: string, checks: RenderCheck[]): string {
  const width = 96;
  const top = `┌${"─".repeat(width)}┐`;
  const bottom = `└${"─".repeat(width)}┘`;
  const headerText = title.slice(0, width - 2);
  const header = `│ ${chalk.bold(headerText)}${" ".repeat(width - headerText.length - 1)}│`;
  const rows = checks.map((check) => {
    const color = COLORS[check.level];
    const symbol = color(SYMBOLS[check.level]);
    const labelWidth = 26;
    const detailWidth = width - labelWidth - 6;
    const label = ellipsize(check.label, labelWidth).padEnd(labelWidth);
    const detail = ellipsize(check.detail, detailWidth).padEnd(detailWidth);
    return `│ ${symbol} ${label} ${chalk.gray(detail)} │`;
  });
  return [top, header, `├${"─".repeat(width)}┤`, ...rows, bottom].join("\n");
}

export function renderKeyValue(title: string, values: Array<[string, string | number]>): string {
  const checks = values.map(([label, value]) => ({
    level: "info" as const,
    label,
    detail: String(value),
  }));
  return renderChecks(title, checks);
}

function ellipsize(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}
