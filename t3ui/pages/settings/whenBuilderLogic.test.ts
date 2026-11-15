import { expect, test } from "nsh/test";
import { parseWhen } from "../../commands/whenClause";
import { DEFAULT_KEYBINDING_RULES } from "../../commands/defaultKeybindings";
import { keycaps } from "./keybindingsLogic";
import {
  buildWhenExpressionGroup, conditionParts, defaultWhenGroup, defaultWhenVariable, flattenWhenChildren, parseWhenDraft, setConditionIdentifier, setConditionNegated,
  whenNodeRemoveLabel, whenVariableOptions,
} from "./whenBuilderLogic";
import { whenToExpression } from "./keybindingsLogic";

test("keycaps are one per part, with the web's symbols and upper-cased letters", () => {
  expect(keycaps("mod+shift+f")).toEqual(["⌘", "⇧", "F"]);
  expect(keycaps("mod+alt+b")).toEqual(["⌘", "⌥", "B"]);
  expect(keycaps("ctrl+arrowup")).toEqual(["⌃", "arrowup"]);
  expect(keycaps("mod++")).toEqual(["⌘", "+"]);
});

test("conditions are negated and renamed without losing their shape", () => {
  const node = parseWhen("!terminalFocus")!;
  expect(conditionParts(node)).toEqual({ identifier: "terminalFocus", negated: true });
  expect(whenToExpression(setConditionNegated(node, false))).toBe("terminalFocus");
  expect(whenToExpression(setConditionIdentifier(node, "previewOpen"))).toBe("!previewOpen");
  expect(conditionParts(parseWhen("a && b")!)).toBe(null);
});

test("a run of one operator flattens and rebuilds left-leaning", () => {
  const node = parseWhen("a && b && c")!;
  const children = flattenWhenChildren(node, "and");
  expect(children.map((child) => whenToExpression(child))).toEqual(["a", "b", "c"]);
  expect(whenToExpression(buildWhenExpressionGroup(children, "or")!)).toBe("(a || b) || c");
  expect(buildWhenExpressionGroup([], "and")).toBe(undefined);
  expect(whenToExpression(defaultWhenGroup("terminalFocus", "or"))).toBe("terminalFocus || !terminalFocus");
});

test("the variable options list the core variables first, in order, then the rest alphabetically", () => {
  const options = whenVariableOptions(DEFAULT_KEYBINDING_RULES);
  expect(options.slice(0, 7)).toEqual(["terminalFocus", "terminalOpen", "previewOpen", "isWeb", "isDesktop", "true", "false"]);
  expect(defaultWhenVariable(DEFAULT_KEYBINDING_RULES)).toBe("terminalFocus");
  const rest = options.slice(7);
  expect(rest).toEqual([...rest].sort((left, right) => left.localeCompare(right)));
});

test("remove labels and expression drafts follow the web", () => {
  expect(whenNodeRemoveLabel(parseWhen("a")!, 0)).toBe("Clear all conditions");
  expect(whenNodeRemoveLabel(parseWhen("!a")!, 1)).toBe("Remove condition");
  expect(whenNodeRemoveLabel(parseWhen("a && b")!, 1)).toBe("Remove group and its conditions");
  expect(parseWhenDraft("  ")).toEqual({ ok: true, value: undefined });
  expect(parseWhenDraft("a &&")).toEqual({ ok: false, message: "Use variables with !, &&, ||, and parentheses." });
});
