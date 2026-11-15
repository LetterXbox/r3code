// The keybinding when-clause language (packages/shared/src/keybindings.ts
// parseKeybindingWhenExpression + keybindings.ts evaluateWhenNode): identifiers,
// `!`, `&&`, `||` and parentheses. `true` and `false` are literals; any other
// identifier reads the focus context and is false when the context lacks it.
export type WhenNode =
  | { type: "identifier"; name: string }
  | { type: "not"; node: WhenNode }
  | { type: "and"; left: WhenNode; right: WhenNode }
  | { type: "or"; left: WhenNode; right: WhenNode };

type Token = { type: "identifier"; value: string } | { type: "not" | "and" | "or" | "lparen" | "rparen" };

const MAX_DEPTH = 64;

function tokenize(expression: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const current = expression[index]!;
    if (/\s/.test(current)) { index += 1; continue; }
    if (expression.startsWith("&&", index)) { tokens.push({ type: "and" }); index += 2; continue; }
    if (expression.startsWith("||", index)) { tokens.push({ type: "or" }); index += 2; continue; }
    if (current === "!") { tokens.push({ type: "not" }); index += 1; continue; }
    if (current === "(") { tokens.push({ type: "lparen" }); index += 1; continue; }
    if (current === ")") { tokens.push({ type: "rparen" }); index += 1; continue; }
    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(index));
    if (!identifier) return null;
    tokens.push({ type: "identifier", value: identifier[0] });
    index += identifier[0].length;
  }
  return tokens;
}

/** Parses a when expression; null when it is empty or malformed. */
export function parseWhen(expression: string): WhenNode | null {
  const tokens = tokenize(expression);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;
  const primary = (depth: number): WhenNode | null => {
    if (depth > MAX_DEPTH) return null;
    const token = tokens[index];
    if (!token) return null;
    if (token.type === "identifier") { index += 1; return { type: "identifier", name: token.value }; }
    if (token.type === "lparen") {
      index += 1;
      const inner = or(depth + 1);
      if (!inner || tokens[index]?.type !== "rparen") return null;
      index += 1;
      return inner;
    }
    return null;
  };
  const unary = (depth: number): WhenNode | null => {
    let nots = 0;
    while (tokens[index]?.type === "not") { index += 1; nots += 1; if (nots > MAX_DEPTH) return null; }
    let node = primary(depth);
    if (!node) return null;
    while (nots-- > 0) node = { type: "not", node };
    return node;
  };
  const and = (depth: number): WhenNode | null => {
    let left = unary(depth);
    if (!left) return null;
    while (tokens[index]?.type === "and") {
      index += 1;
      const right = unary(depth);
      if (!right) return null;
      left = { type: "and", left, right };
    }
    return left;
  };
  const or = (depth: number): WhenNode | null => {
    let left = and(depth);
    if (!left) return null;
    while (tokens[index]?.type === "or") {
      index += 1;
      const right = and(depth);
      if (!right) return null;
      left = { type: "or", left, right };
    }
    return left;
  };
  const ast = or(0);
  return ast && index === tokens.length ? ast : null;
}

export function evaluateWhen(node: WhenNode, context: Readonly<Record<string, boolean>>): boolean {
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return Boolean(context[node.name]);
    case "not": return !evaluateWhen(node.node, context);
    case "and": return evaluateWhen(node.left, context) && evaluateWhen(node.right, context);
    case "or": return evaluateWhen(node.left, context) || evaluateWhen(node.right, context);
  }
}

const parsed = new Map<string, WhenNode | null>();

/** True when the clause is empty (always), or parses and holds in `context`. A clause that does not parse never holds. */
export function whenHolds(expression: string, context: Readonly<Record<string, boolean>>): boolean {
  const text = expression.trim();
  if (text.length === 0) return true;
  let node = parsed.get(text);
  if (node === undefined) { node = parseWhen(text); parsed.set(text, node); }
  return node !== null && evaluateWhen(node, context);
}
