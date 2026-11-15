// Pure table serialisation for the copy menu of MarkdownTable ("Copy as Markdown" / "Copy as CSV").
import type { TextViewInline, TextViewTable } from "nsh/base";

/** The visible text of inline markdown content. */
export function inlineText(content: TextViewInline[]): string {
  return content.map((node): string => {
    switch (node.type) {
      case "text": return node.text;
      case "code": return node.code;
      case "keyboard": return node.text;
      case "break": return " ";
      case "math": return node.tex;
      case "image": return node.alt ?? "";
      case "footnoteReference": return `[${node.label}]`;
      case "custom": return node.text ?? (node.content ? inlineText(node.content) : "");
      default: return inlineText(node.content);
    }
  }).join("").replace(/\s+/g, " ").trim();
}

function cells(row: { content: TextViewInline[] }[]): string[] {
  return row.map((cell) => inlineText(cell.content));
}

export function tableToMarkdown(table: TextViewTable): string {
  const escape = (value: string) => value.replace(/\|/g, "\\|");
  const head = cells(table.head);
  const marker = (index: number) => {
    const align = table.align?.[index];
    if (align === "center") return ":---:";
    if (align === "right") return "---:";
    if (align === "left") return ":---";
    return "---";
  };
  const lines = [
    `| ${head.map(escape).join(" | ")} |`,
    `| ${head.map((_, index) => marker(index)).join(" | ")} |`,
    ...(table.rows ?? []).map((row) => `| ${cells(row).map(escape).join(" | ")} |`),
  ];
  return lines.join("\n");
}

export function tableToCsv(table: TextViewTable): string {
  const quote = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return [cells(table.head), ...(table.rows ?? []).map(cells)].map((row) => row.map(quote).join(",")).join("\n");
}
