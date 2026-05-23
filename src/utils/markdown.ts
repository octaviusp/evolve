import matter from "gray-matter";

export function parseFrontmatter(content: string): Record<string, unknown> {
  try {
    return matter(content).data;
  } catch {
    return {};
  }
}

export function extractSections(content: string): string[] {
  return content
    .split(/\r?\n/)
    .filter((line) => /^#{1,4}\s+\S/.test(line))
    .map((line) => line.trim())
    .slice(0, 80);
}

export function hasEvolveBlock(content: string): boolean {
  return content.includes("<!-- EVOLVE:BEGIN");
}

export function replaceEvolveBlock(
  content: string,
  blockName: string,
  replacement: string,
): string | undefined {
  const escaped = blockName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<!-- EVOLVE:BEGIN ${escaped} -->[\\s\\S]*?<!-- EVOLVE:END ${escaped} -->`,
    "m",
  );
  const nextBlock = `<!-- EVOLVE:BEGIN ${blockName} -->\n${replacement.trim()}\n<!-- EVOLVE:END ${blockName} -->`;
  if (pattern.test(content)) return content.replace(pattern, nextBlock);
  if (hasEvolveBlock(content)) return undefined;
  return `${content.trimEnd()}\n\n${nextBlock}\n`;
}
