// The keybindings When control and its builder, ported from KeybindingsSettings.tsx (WhenClauseControl,
// WhenExpressionBuilder, WhenExpressionNodeEditor, WhenVariableSelect): a ghost button showing the clause and a
// chevron, opening a popover with an expression field and a visual editor of conditions and groups.
import { signal, Text, token, View } from "nsh";
import { Input, Select } from "nsh/base";
import { createAnchor, Popup } from "../../components/composer/Popover";
import { useOverlayOpen } from "../../components/rightPanel/nativeOcclusion";
import { codeTextStyle } from "../../typography";
import { SettingsIcon } from "./SettingsIcon";
import { knownWhenVariables, whenToExpression, type DefaultRule } from "./keybindingsLogic";
import {
  buildWhenExpressionGroup, conditionParts, defaultWhenCondition, defaultWhenGroup, defaultWhenVariable, flattenWhenChildren,
  parseWhenDraft, setConditionIdentifier, setConditionNegated, whenIdentifiers, whenNodeRemoveLabel, whenVariableOptions, type BooleanOperator,
} from "./whenBuilderLogic";
import type { WhenNode } from "../../commands/whenClause";

const OUTLINE_BUTTON = "h-7 flex-row items-center gap-1 rounded-md border border-input bg-background px-[7px] hover:bg-accent dark:bg-input-32 active:scale-[0.97] transition-transform duration-150 ease-in-out";

/** Warning for identifiers T3 Code does not know (`UnknownWhenVariableWarning`). */
export function unknownConditionLabel(identifiers: readonly string[]): string {
  return identifiers.length === 1 ? `Unknown condition: ${identifiers[0]}` : `Unknown conditions: ${identifiers.join(", ")}`;
}

export const UNKNOWN_CONDITION_HINT = "R3 Code does not recognize this condition yet. It can still be saved, but it may not match unless the runtime provides it.";

export function WarningMark(props: { label: string; hint: string; size?: number }) {
  return (
    <View class="size-5 items-center justify-center rounded-sm" accessibilityLabel={props.label} tooltip={`${props.label}. ${props.hint}`} testID={props.label}>
      <SettingsIcon name="triangle-alert" size={props.size ?? 14} tint={token("warning")} />
    </View>
  );
}

/** A compact choice (`SelectTrigger size="compact"`): a `h-7 rounded-md text-xs` trigger and a popup of items. */
function CompactSelect(props: { label: string; value: string; options: string[]; onChange: (next: string) => void; class?: string; unknown?: boolean }) {
  const open = signal(false);
  useOverlayOpen(() => open(), "when select");
  return (
    <Select
      open={open()}
      onOpenChange={(event: { open: boolean }) => open.set(event.open)}
      value={props.value}
      align="start"
      items={props.options.map((option) => ({ value: option, title: option }))}
      onChange={(event: { value: string | null }) => { if (event.value !== null) props.onChange(event.value); }}
      trigger={
        <View
          class={`h-7 flex-row items-center justify-between gap-1 rounded-md border border-input bg-background px-[7px] dark:bg-input-32 ${props.class ?? ""}`}
          accessibilityLabel={`${props.label} = ${props.value}`}
          testID={`${props.label} = ${props.value}`}
        >
          <Text class="min-w-0 flex-1 truncate text-xs text-foreground">{props.value}</Text>
          {props.unknown ? <SettingsIcon name="triangle-alert" size={14} tint={token("warning")} /> : null}
          <View class="-mr-1 opacity-70"><SettingsIcon name="chevron-down" size={14} tint={token("icon-muted")} /></View>
        </View>
      }
      itemClass="min-h-7 flex-row items-center rounded-sm px-2 py-1 text-sm text-popover-foreground selected:bg-accent-50 focus:bg-accent hover:bg-accent"
      popupClass="max-h-72 min-w-24 rounded-lg border border-border bg-popover-84 p-1 shadow-lg"
      class={`h-7 ${props.class ?? ""}`}
    />
  );
}

function RemoveButton(props: { label: string; onRemove: () => void; class?: string }) {
  return (
    <View role="button" accessibilityLabel={props.label} tooltip={props.label} onPress={props.onRemove} class={`size-7 items-center justify-center rounded-lg hover:bg-accent ${props.class ?? ""}`}>
      <SettingsIcon name="minus" size={14} />
    </View>
  );
}

function ActionButton(props: { label: string; onPress: () => void; primary?: boolean }) {
  return (
    <View
      role="button"
      accessibilityLabel={`Add ${props.label.toLowerCase()}`}
      onPress={props.onPress}
      class={props.primary ? "h-7 flex-row items-center gap-1 rounded-md border border-primary bg-primary px-[7px] active:scale-[0.97] transition-transform duration-150 ease-in-out" : OUTLINE_BUTTON}
    >
      <SettingsIcon name="plus" size={14} />
      <Text class={props.primary ? "text-xs font-medium text-primary-foreground" : "text-xs font-medium text-foreground"}>{props.label}</Text>
    </View>
  );
}

type NodeEditorProps = {
  node: () => WhenNode;
  variables: string[];
  known: string[];
  fallback: string;
  depth: number;
  onChange: (node: WhenNode) => void;
  onRemove?: () => void;
};

/** One node of the clause: a condition (Not toggle and variable), a negated group, or an and/or group of operands. */
function NodeEditor(props: NodeEditorProps) {
  const condition = () => conditionParts(props.node());
  const node = props.node;
  const isNotGroup = () => condition() === null && node().type === "not";
  const operator = (): BooleanOperator => (node().type === "or" ? "or" : "and");
  const children = () => (condition() === null && node().type !== "not" ? flattenWhenChildren(node(), operator()) : []);
  const keyed = () => {
    const seen = new Map<string, number>();
    return children().map((child) => {
      const base = `${child.type}-${whenToExpression(child)}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return { child, key: count === 0 ? base : `${base}-${count}` };
    });
  };
  const updateChild = (target: WhenNode, next: WhenNode) => {
    let done = false;
    const merged = buildWhenExpressionGroup(children().map((child) => (!done && child === target ? ((done = true), next) : child)), operator());
    if (merged) props.onChange(merged);
  };
  const removeChild = (target: WhenNode) => {
    let done = false;
    const merged = buildWhenExpressionGroup(children().filter((child) => (!done && child === target ? ((done = true), false) : true)), operator());
    props.onChange(merged ?? defaultWhenCondition(props.fallback));
  };
  const setOperator = (next: BooleanOperator) => {
    if (next === operator()) return;
    const merged = buildWhenExpressionGroup(children(), next);
    if (merged) props.onChange(merged);
  };
  const addCondition = () => {
    const merged = buildWhenExpressionGroup([...children(), defaultWhenCondition(props.fallback)], operator());
    if (merged) props.onChange(merged);
  };
  const addGroup = () => {
    const merged = buildWhenExpressionGroup([...children(), defaultWhenGroup(props.fallback, operator() === "and" ? "or" : "and")], operator());
    if (merged) props.onChange(merged);
  };
  const options = () => {
    const current = condition()?.identifier;
    return current !== undefined && !props.variables.includes(current) ? [current, ...props.variables] : props.variables;
  };
  const nested = () => props.depth > 0;
  const rail = () => (props.depth === 0 ? "bg-border" : "bg-when-border-nested");
  return (
    <View>
      {condition() !== null ? (
        <View class="flex-row items-center gap-2 rounded-md border border-when-border-nested bg-when-condition px-2 py-2">
          <View
            role="button"
            accessibilityLabel={`Negate ${condition()!.identifier}`}
            testID={`Negate ${condition()!.identifier} (${condition()!.negated ? "on" : "off"})`}
            onPress={() => props.onChange(setConditionNegated(node(), !condition()!.negated))}
            class={condition()!.negated ? "h-7 min-w-10 items-center justify-center rounded-md border border-input bg-accent px-[7px]" : "h-7 min-w-10 items-center justify-center rounded-md border border-input bg-background px-[7px] hover:bg-accent dark:bg-input-32 transition-colors duration-150 ease-in-out"}
          >
            <Text class="text-xs font-medium text-foreground">Not</Text>
          </View>
          <CompactSelect
            label="Condition"
            class="min-w-0 flex-1"
            value={condition()!.identifier}
            options={options()}
            unknown={!props.known.includes(condition()!.identifier)}
            onChange={(next) => props.onChange(setConditionIdentifier(node(), next))}
          />
          {props.onRemove ? <RemoveButton label={whenNodeRemoveLabel(node(), props.depth)} onRemove={props.onRemove} /> : null}
        </View>
      ) : null}
      {isNotGroup() ? (
        <View class={nested() ? "gap-2 rounded-lg border border-when-border-nested bg-when-group-nested p-2" : "gap-2 rounded-lg border border-when-border-nested bg-when-not p-2"}>
          <View class="flex-row items-center gap-2">
            <View
              role="button"
              accessibilityLabel="Negate group"
              onPress={() => props.onChange((node() as { node: WhenNode }).node)}
              class="h-7 min-w-10 items-center justify-center rounded-md border border-input bg-accent px-[7px]"
            >
              <Text class="text-xs font-medium text-foreground">Not</Text>
            </View>
            <View class="flex-1" />
            {props.onRemove ? <RemoveButton label={whenNodeRemoveLabel(node(), props.depth)} onRemove={props.onRemove} /> : null}
          </View>
          <View class="pl-4">
            <View class={`absolute top-0 bottom-0 left-1.5 w-px ${rail()}`} />
            <View class={`absolute top-4 left-1.5 h-px w-2.5 ${rail()}`} />
            {node().type === "not" ? (
              <NodeEditor
                node={() => (node() as { node: WhenNode }).node}
                variables={props.variables}
                known={props.known}
                fallback={props.fallback}
                depth={props.depth + 1}
                onChange={(next) => props.onChange({ type: "not", node: next })}
              />
            ) : null}
          </View>
        </View>
      ) : null}
      {condition() === null && !isNotGroup() ? (
        <View class={nested() ? "gap-2 rounded-lg border border-when-border-nested bg-when-group-nested p-2" : "gap-2 rounded-lg border border-when-border bg-when-group p-2"}>
          <View class="flex-row flex-wrap items-center gap-2">
            <CompactSelect label="Operator" class="w-24" value={operator()} options={["and", "or"]} onChange={(next) => setOperator(next as BooleanOperator)} />
            <ActionButton label="Condition" onPress={addCondition} />
            <ActionButton label="Group" onPress={addGroup} />
            <View class="flex-1" />
            {props.onRemove ? <RemoveButton label={whenNodeRemoveLabel(node(), props.depth)} onRemove={props.onRemove} /> : null}
          </View>
          <View class="gap-2">
            <Each of={keyed()} key={(entry) => entry.key}>
              {(entry) => (
                <View class="pl-4">
                  <View class={`absolute top-0 bottom-0 left-1.5 w-px ${rail()}`} />
                  <View class={`absolute top-4 left-1.5 h-px w-2.5 ${rail()}`} />
                  <NodeEditor
                    node={() => entry().child}
                    variables={props.variables}
                    known={props.known}
                    fallback={props.fallback}
                    depth={props.depth + 1}
                    onChange={(next) => updateChild(entry().child, next)}
                    onRemove={() => removeChild(entry().child)}
                  />
                </View>
              )}
            </Each>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** The popover's content: the expression field over the visual editor. */
function WhenExpressionBuilder(props: {
  value: () => WhenNode | undefined;
  variables: string[];
  known: string[];
  fallback: string;
  onChange: (value: WhenNode | undefined) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const draft = signal(whenToExpression(props.value()));
  const parsed = () => parseWhenDraft(draft());
  const parseError = () => { const result = parsed(); return result.ok ? null : result.message; };
  const unknown = () => { const result = parsed(); return result.ok ? [...whenIdentifiers(result.value)].filter((name) => !props.known.includes(name)).sort() : []; };
  const updateDraft = (next: string) => {
    draft.set(next);
    const result = parseWhenDraft(next);
    props.onValidityChange(result.ok);
    if (result.ok) props.onChange(result.value);
  };
  const updateValue = (next: WhenNode | undefined) => {
    draft.set(whenToExpression(next));
    props.onValidityChange(true);
    props.onChange(next);
  };
  const addRootCondition = () => {
    const value = props.value();
    updateValue(value ? { type: "and", left: value, right: defaultWhenCondition(props.fallback) } : defaultWhenCondition(props.fallback));
  };
  const addRootGroup = () => {
    const value = props.value();
    const group = defaultWhenGroup(props.fallback, "or");
    updateValue(value ? { type: "and", left: value, right: group } : group);
  };
  return (
    <View class="w-[544px] max-w-full gap-3" accessibilityLabel="When clause builder">
      <View class="flex-row items-start justify-between gap-3">
        <Text class="text-sm font-medium text-foreground">When</Text>
        <View class="flex-row items-center gap-2">
          <ActionButton label="Condition" onPress={addRootCondition} />
          <ActionButton label="Group" onPress={addRootGroup} />
        </View>
      </View>
      <View class="gap-1.5">
        <View class={`h-7 flex-row items-center rounded-md border bg-background dark:bg-input-32 ${parseError() ? "border-destructive" : "border-input"}`}>
          <Input
            value={draft()}
            placeholder="Always"
            accessibilityLabel="When expression"
            autoCapitalize="none"
            autoCorrect={false}
            onChange={(event) => updateDraft(event.value)}
            style={{ fontFamily: codeTextStyle().fontFamily }}
            class="h-7 min-w-0 flex-1 px-[9px] text-xs text-foreground"
          />
          {unknown().length > 0 ? <View class="pr-2"><WarningMark label={unknownConditionLabel(unknown())} hint={UNKNOWN_CONDITION_HINT} size={16} /></View> : null}
        </View>
        {parseError() ? (
          <View class="flex-row items-center gap-1.5">
            <SettingsIcon name="circle-x" size={14} tint={token("destructive-foreground")} />
            <Text class="text-2xs text-destructive-foreground">{parseError()!}</Text>
          </View>
        ) : null}
      </View>
      <View>
        {props.value() ? (
          <NodeEditor node={() => props.value()!} variables={props.variables} known={props.known} fallback={props.fallback} depth={0} onChange={updateValue} onRemove={() => updateValue(undefined)} />
        ) : (
          <View class="rounded-md border border-dashed border-when-empty-border bg-when-empty p-3">
            <View class="flex-row flex-wrap gap-2">
              <ActionButton label="Condition" primary onPress={addRootCondition} />
              <ActionButton label="Group" onPress={addRootGroup} />
            </View>
          </View>
        )}
        {parseError() ? (
          <View class="absolute inset-0 items-center justify-center rounded-lg border border-destructive bg-background p-4" style={{ opacity: 0.75, pointerEvents: "none" }}>
            <Text class="text-center text-xs text-destructive-foreground">Fix the expression above to continue editing visually.</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The row's `When <clause> v` control: a ghost micro button, opening the builder under it. */
export function WhenClauseControl(props: {
  label: string;
  expression: () => string;
  value: () => WhenNode | undefined;
  defaults: DefaultRule[];
  onChange: (value: WhenNode | undefined) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const open = signal(false);
  const anchor = createAnchor();
  const variables = whenVariableOptions(props.defaults);
  const known = knownWhenVariables(props.defaults);
  const fallback = defaultWhenVariable(props.defaults);
  const close = () => { open.set(false); props.onValidityChange(true); };
  return (
    <View class="min-w-0 shrink">
      <View
        ref={anchor.ref}
        role="button"
        accessibilityLabel={`Edit when clause for ${props.label}`}
        onPress={() => (open() ? close() : open.set(true))}
        class="h-5 min-w-0 shrink flex-row items-center gap-1 rounded-sm px-[5px] hover:bg-accent"
      >
        <Text class={`min-w-0 truncate text-[11px] font-medium ${props.expression() ? "text-foreground" : "text-muted-foreground"}`} style={{ fontFamily: codeTextStyle().fontFamily }}>{props.expression() || "Always"}</Text>
        <View class="opacity-60"><SettingsIcon name="chevron-down" size={14} tint={token("foreground")} /></View>
      </View>
      {open() ? (
        <Popup anchor={anchor.anchor} onClose={close} placement="bottom" align="start" class="p-4">
          <WhenExpressionBuilder value={props.value} variables={variables} known={known} fallback={fallback} onChange={props.onChange} onValidityChange={props.onValidityChange} />
        </Popup>
      ) : null}
    </View>
  );
}
