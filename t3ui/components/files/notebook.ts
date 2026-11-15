// Jupyter notebook reading for the notebook viewer (NotebookPreview.tsx). nbformat 4; pure.

export type NotebookOutput =
  | { kind: "text"; text: string; stream?: "stdout" | "stderr" }
  | { kind: "image"; src: string }
  | { kind: "error"; text: string };

export interface NotebookCell {
  id: string;
  type: "markdown" | "code" | "raw";
  source: string;
  executionCount: number | null;
  outputs: NotebookOutput[];
}

export interface Notebook { language: string; cells: NotebookCell[] }

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
// extendedDocumentPreview's notebookText: a cell's text, at most 256,000 characters (4 MB for an image's base64).
const joined = (value: unknown, limit = 256_000): string => {
  const result = Array.isArray(value) ? value.filter((part): part is string => typeof part === "string").join("") : typeof value === "string" ? value : "";
  if (result.length > limit) throw new Error("A notebook cell is too large to preview.");
  return result;
};
/** openNotebook's bound: notebooks over 8 MB are not previewed. */
export const NOTEBOOK_MAX_BYTES = 8 * 1024 * 1024;
// Terminal colour escapes in tracebacks are not drawn.
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

function readOutput(value: unknown): NotebookOutput[] {
  if (!object(value)) return [];
  if (value.output_type === "stream") return [{ kind: "text", text: joined(value.text), stream: value.name === "stderr" ? "stderr" : "stdout" }];
  if (value.output_type === "error") {
    const trace = Array.isArray(value.traceback) ? stripAnsi(value.traceback.filter((line): line is string => typeof line === "string").join("\n")) : "";
    return [{ kind: "error", text: trace || `${String(value.ename ?? "Error")}: ${String(value.evalue ?? "")}` }];
  }
  const data = value.data;
  if (!object(data)) return [];
  const png = joined(data["image/png"], 4 * 1024 * 1024).replace(/\s+/g, "");
  if (png) return [{ kind: "image", src: `data:image/png;base64,${png}` }];
  const jpeg = joined(data["image/jpeg"], 4 * 1024 * 1024).replace(/\s+/g, "");
  if (jpeg) return [{ kind: "image", src: `data:image/jpeg;base64,${jpeg}` }];
  const plain = joined(data["text/plain"]);
  return plain ? [{ kind: "text", text: plain }] : [];
}

/** Reads a notebook's JSON; throws a sentence the viewer shows when it is not a notebook. */
export function parseNotebook(text: string): Notebook {
  if (new TextEncoder().encode(text).length > NOTEBOOK_MAX_BYTES) throw new Error("Notebook preview limited to files under 8 MB.");
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error("This notebook is not valid JSON."); }
  // openNotebook: version 4 notebooks with up to 500 cells.
  if (!object(json) || json.nbformat !== 4 || !Array.isArray(json.cells) || json.cells.length > 500) throw new Error("Preview supports version 4 notebooks with up to 500 cells.");
  const metadata = object(json.metadata) ? json.metadata : {};
  const kernel = object(metadata.kernelspec) ? metadata.kernelspec : {};
  const info = object(metadata.language_info) ? metadata.language_info : {};
  const language = typeof info.name === "string" ? info.name : typeof kernel.language === "string" ? kernel.language : "python";
  const cells: NotebookCell[] = [];
  json.cells.forEach((cell, index) => {
    if (!object(cell)) return;
    const type = cell.cell_type === "markdown" || cell.cell_type === "code" ? cell.cell_type : "raw";
    if (Array.isArray(cell.outputs) && cell.outputs.length > 100) throw new Error("A notebook cell has too many outputs to preview.");
    cells.push({
      id: typeof cell.id === "string" ? cell.id : String(index),
      type,
      source: joined(cell.source),
      executionCount: typeof cell.execution_count === "number" ? cell.execution_count : null,
      outputs: type === "code" && Array.isArray(cell.outputs) ? cell.outputs.flatMap(readOutput) : [],
    });
  });
  return { language, cells };
}
