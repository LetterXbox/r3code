// The pure half of the keybindings When builder, ported from components/settings/KeybindingsSettings.tsx
// (conditionParts, setCondition*, defaultWhen*, flattenWhenChildren, buildWhenExpressionGroup) and
// KeybindingsSettings.logic.ts (buildWhenVariableOptions, whenNodeRemoveLabel, parseWhenExpressionDraft).
import { parseWhen, type WhenNode } from "../../commands/whenClause";
import { CORE_WHEN_VARIABLES, WHEN_PARSE_MESSAGE, knownWhenVariables, type DefaultRule } from "./keybindingsLogic";

export type BooleanOperator = "and" | "or";

/** The identifier a condition names, and whether it is negated, or null for a node that is a group. */
export function conditionParts(node: WhenNode): { identifier: string; negated: boolean } | null {
  if (node.type === "identifier") return { identifier: node.name, negated: false };
  if (node.type === "not" && node.node.type === "identifier") return { identifier: node.node.name, negated: true };
  return null;
}

export function setConditionIdentifier(node: WhenNode, identifier: string): WhenNode {
  const parts = conditionParts(node);
  if (!parts) return node;
  const next: WhenNode = { type: "identifier", name: identifier };
  return parts.negated ? { type: "not", node: next } : next;
}

export function setConditionNegated(node: WhenNode, negated: boolean): WhenNode {
  const parts = conditionParts(node);
  if (!parts) return negated ? { type: "not", node } : node;
  const identifier: WhenNode = { type: "identifier", name: parts.identifier };
  return negated ? { type: "not", node: identifier } : identifier;
}

/** The variable a new condition starts as: the first of the known ones that is not a literal. */
export function defaultWhenVariable(defaults: DefaultRule[]): string {
  return knownWhenVariables(defaults).find((identifier) => identifier !== "true" && identifier !== "false") ?? "terminalFocus";
}

export function defaultWhenCondition(variable: string): WhenNode {
  return { type: "identifier", name: variable };
}

/** A new group: the variable and its negation, joined by `operator`. */
export function defaultWhenGroup(variable: string, operator: BooleanOperator = "and"): WhenNode {
  return { type: operator, left: defaultWhenCondition(variable), right: { type: "not", node: defaultWhenCondition(variable) } };
}

/** The operands of a run of the same operator, left to right. */
export function flattenWhenChildren(node: WhenNode, operator: BooleanOperator): WhenNode[] {
  if (node.type !== operator) return [node];
  return [...flattenWhenChildren(node.left, operator), ...flattenWhenChildren(node.right, operator)];
}

/** The operands joined left-leaning by `operator`; undefined when there are none. */
export function buildWhenExpressionGroup(children: readonly WhenNode[], operator: BooleanOperator): WhenNode | undefined {
  const first = children[0];
  if (!first) return undefined;
  return children.slice(1).reduce<WhenNode>((left, right) => ({ type: operator, left, right }), first);
}

/** The variables a condition can pick: the known ones, the core ones first in their order, the rest alphabetical. */
const optionsByDefaults = new WeakMap<DefaultRule[], readonly string[]>();
export function whenVariableOptions(defaults: DefaultRule[]): string[] {
  const cached = optionsByDefaults.get(defaults);
  if (cached) return [...cached];
  const sorted = sortWhenVariables(knownWhenVariables(defaults));
  optionsByDefaults.set(defaults, sorted);
  return [...sorted];
}
function sortWhenVariables(variables: string[]): string[] {
  const core = CORE_WHEN_VARIABLES as readonly string[];
  return [...variables].sort((left, right) => {
    const leftCore = core.indexOf(left);
    const rightCore = core.indexOf(right);
    if (leftCore !== -1 || rightCore !== -1) return (leftCore === -1 ? Number.MAX_SAFE_INTEGER : leftCore) - (rightCore === -1 ? Number.MAX_SAFE_INTEGER : rightCore);
    return left.localeCompare(right);
  });
}

export function whenNodeRemoveLabel(node: WhenNode, depth: number): string {
  if (depth === 0) return "Clear all conditions";
  if (node.type === "identifier" || (node.type === "not" && node.node.type === "identifier")) return "Remove condition";
  return "Remove group and its conditions";
}

/** An expression field's draft: empty is "no condition", otherwise it parses or says why not. */
export function parseWhenDraft(expression: string): { ok: true; value: WhenNode | undefined } | { ok: false; message: string } {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };
  const value = parseWhen(trimmed);
  return value ? { ok: true, value } : { ok: false, message: WHEN_PARSE_MESSAGE };
}

/** The identifiers of a tree, in order of first use. */
export function whenIdentifiers(node: WhenNode | undefined, into: Set<string> = new Set()): Set<string> {
  if (!node) return into;
  if (node.type === "identifier") into.add(node.name);
  else if (node.type === "not") whenIdentifiers(node.node, into);
  else { whenIdentifiers(node.left, into); whenIdentifiers(node.right, into); }
  return into;
}
