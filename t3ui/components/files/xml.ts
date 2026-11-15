// A small XML reader for the document viewers (the web app reads Open XML and OpenDocument with saxes / a parser of its own
// in files/extendedDocumentPreview.ts). Elements keep their prefixed names (`w:p`, `table:table`); text is `#text` nodes.
// No DTD, namespace or schema handling: documents are previewed, not validated. Pure, so it is tested without an engine.

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** The text of a `#text` node. */
  text: string;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·", laquo: "«", raquo: "»", euro: "€", pound: "£", yen: "¥" };

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED[body] ?? NAMED[body.toLowerCase()] ?? all;
  });
}

const MAX_NODES = 3_000_000;
const MAX_DEPTH = 256;

/** `strict` is XMLValidator's well-formedness (extendedDocumentPreview): a closer that does not match the open element, an
 * element left open, or an HTML void element without `/>` is invalid XML. */
export function parseXml(source: string, options: { strict?: boolean } = {}): XmlNode {
  const strict = options.strict === true;
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let nodes = 0;
  const length = source.length;
  while (index < length) {
    const lt = source.indexOf("<", index);
    const end = lt < 0 ? length : lt;
    if (end > index) {
      const raw = source.slice(index, end);
      const top = stack[stack.length - 1]!;
      if (top !== root) top.children.push({ name: "#text", attrs: {}, children: [], text: decodeEntities(raw) });
    }
    if (lt < 0) break;
    if (source.startsWith("<!--", lt)) {
      const close = source.indexOf("-->", lt + 4);
      if (close < 0) throw new Error("This document contains invalid XML.");
      index = close + 3;
    } else if (source.startsWith("<![CDATA[", lt)) {
      const close = source.indexOf("]]>", lt + 9);
      if (close < 0) throw new Error("This document contains invalid XML.");
      stack[stack.length - 1]!.children.push({ name: "#text", attrs: {}, children: [], text: source.slice(lt + 9, close) });
      index = close + 3;
    } else if (source.startsWith("<?", lt)) {
      const close = source.indexOf("?>", lt + 2);
      if (close < 0) throw new Error("This document contains invalid XML.");
      index = close + 2;
    } else if (source.startsWith("<!", lt)) {
      // A DOCTYPE, possibly with an internal subset in brackets.
      let depth = 0; let cursor = lt + 2;
      for (; cursor < length; cursor++) {
        const char = source[cursor];
        if (char === "[") depth++;
        else if (char === "]") depth--;
        else if (char === ">" && depth <= 0) break;
      }
      index = cursor + 1;
    } else if (source[lt + 1] === "/") {
      const close = source.indexOf(">", lt + 2);
      if (close < 0) throw new Error("This document contains invalid XML.");
      const name = source.slice(lt + 2, close).trim();
      if (strict) {
        if (stack.length < 2 || stack[stack.length - 1]!.name !== name) throw new Error("This document contains invalid XML.");
        stack.length -= 1;
        index = close + 1;
        continue;
      }
      // Close the nearest matching element; stray closers (HTML in an EPUB) are ignored.
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth]!.name === name) { stack.length = depth; break; }
      }
      index = close + 1;
    } else {
      let cursor = lt + 1;
      let quote = "";
      for (; cursor < length; cursor++) {
        const char = source[cursor];
        if (quote) { if (char === quote) quote = ""; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === ">") break;
      }
      if (cursor >= length) throw new Error("This document contains invalid XML.");
      let body = source.slice(lt + 1, cursor);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const space = body.search(/\s/);
      const name = space < 0 ? body : body.slice(0, space);
      const attrs: Record<string, string> = {};
      if (space >= 0) {
        const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        const rest = body.slice(space);
        for (let match = pattern.exec(rest); match; match = pattern.exec(rest)) attrs[match[1]!] = decodeEntities(match[2] ?? match[3] ?? "");
      }
      if (++nodes > MAX_NODES) throw new Error("This document is too large to preview.");
      const node: XmlNode = { name, attrs, children: [], text: "" };
      stack[stack.length - 1]!.children.push(node);
      if (!selfClosing && (strict || !/^(?:br|hr|img|meta|link|input|col|area|base|wbr)$/i.test(name))) {
        if (stack.length > MAX_DEPTH) throw new Error("This document is nested too deeply to preview.");
        stack.push(node);
      }
      index = cursor + 1;
    }
  }
  if (strict && stack.length > 1) throw new Error("This document contains invalid XML.");
  return root;
}

/** Every descendant element with this name, in document order; `skip` names elements whose subtree is left out. */
export function findAll(node: XmlNode, name: string, skip?: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (current: XmlNode) => {
    for (const child of current.children) {
      if (child.name === "#text") continue;
      if (child.name === name) out.push(child);
      if (child.name !== skip) walk(child);
    }
  };
  walk(node);
  return out;
}

export const childrenNamed = (node: XmlNode, name: string): XmlNode[] => node.children.filter((child) => child.name === name);
export const firstChild = (node: XmlNode, name: string): XmlNode | undefined => node.children.find((child) => child.name === name);

/** The text of an element and everything in it. */
export function textOf(node: XmlNode, skip?: string): string {
  if (node.name === "#text") return node.text;
  let out = "";
  for (const child of node.children) if (child.name !== skip) out += textOf(child, skip);
  return out;
}
