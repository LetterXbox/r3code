// Limits tab, ported from usage/UsageLimitsPooled.tsx: one section per provider (its mark and name), a bordered card per
// window with the label, the large "N% left" figure with its pace icon, and a bar with one segment per signed-in account
// (the accounts of one login are merged across environments). A segment shows the account's remaining quota, a hatched
// refill where spent weekly quota blocks the session, the even-pace tick, the reset time and banked credits; its popover
// carries the account's details and the reset-credit action. External "Manage usage" links and notices follow.
import { openUrl, signal, Text, View } from "nsh";
import { UsageIcon } from "./UsageIcon";
import type { UsageLimitAccount, UsageLimitWindow } from "../../pages/utility-data";
import { requestBackend } from "../../store";
import { createAnchor, Popup } from "../composer/Popover";
import { confirm } from "../toast";
import { RedactedSensitiveText } from "../../pages/settings/providers/RedactedText";
import { ProviderIconView } from "../../pages/settings/providers/ui";
import { ProviderMark } from "./ProviderMark";
import { requestUsageEnvironment } from "./usageEnvironments";
import { formatResetsIn, paceOf, paceRemainingPercent, PACE_DESCRIPTION, providerForDriver, remainingPercent } from "./usageFormat";
import {
  accountChipColors, accountInitials, collectExternalUsageLinks, collectLimitNotices, collectLimitPools, collectPoolAccounts, cursorWindowDetails,
  displayLimitWindows, formatUpcomingTimestamp, paceMark, type LimitPool, type PoolAccount, type PoolWindow,
} from "./usagePools";
import { CHATGPT_USAGE_URL, redeemResetCredit, resetCreditsSummary } from "./usageResetCredits";

export type LimitsRequest = (environmentId: string | undefined, method: string, payload: unknown) => Promise<unknown>;
const liveRequest: LimitsRequest = (environmentId, method, payload) => (environmentId ? requestUsageEnvironment(environmentId, method, payload) : requestBackend(method, payload));

/** 35% of the provider colour: the bar's own fill, over `bg-muted` (PoolSegment's `opacity-35`). */
function fill(color: string): string {
  return /^#[0-9a-f]{6}$/iu.test(color) ? `${color}59` : color;
}

const providerLabel = (driver: string) => providerForDriver(driver)?.label ?? driver;
const accountName = (account: PoolAccount) => account.displayName ?? providerLabel(account.driver);
const accountLabel = (account: PoolAccount) => account.displayName ?? (account.email ? accountInitials(account.email) : account.driver);
/** The bar colour: the account's own accent when it has one, else the provider's. */
const accentOf = (value: string | undefined) => (value && /^#[0-9a-f]{6}$/iu.test(value) ? value : undefined);

/** The width at which a segment prints its labels instead of an index and a legend row (`@2xl/pool`: 42rem). */
const WIDE_BAR = 672;

/** The hatched refill (`repeating-linear-gradient(135deg, c 0 1px, transparent 1px 5px)` at opacity-20), drawn as 1pt strokes at a 5pt pitch. */
function Hatch(props: { color: string; height: number }) {
  const width = signal(0);
  const strokes = () => Array.from({ length: Math.ceil((width() + props.height) / 5) }, (_, index) => index);
  return <View class="absolute inset-0 overflow-hidden" style={{ opacity: 0.2 }} onLayout={(event) => width.set(event.bounds.size.width)} accessibilityLabel="Refill pattern">
    <Each of={strokes()} key={(index) => index}>{(index) => <View class="absolute" style={{ left: index() * 5 - props.height, top: -props.height / 2, width: 1, height: props.height * 2, backgroundColor: props.color, transform: [{ rotate: "45deg" }] }} />}</Each>
  </View>;
}

function AccountAvatar(props: { account: PoolAccount }) {
  return <ProviderIconView driver={props.account.driver} name={accountName(props.account)} accentColor={props.account.accentColor} badge={Boolean(props.account.displayName)} size={20} />;
}

/** AccountName: the display name; an e-mail only account is its coloured initials chip; else the provider's name. */
function AccountName(props: { account: PoolAccount }) {
  const account = () => props.account;
  const chip = () => (account().email ? accountChipColors(account().email as string) : null);
  return account().displayName
    ? <Text class="min-w-0 truncate text-xs font-medium text-foreground">{account().displayName}</Text>
    : account().email
      ? <View accessibilityLabel={`Account ${accountInitials(account().email as string)}`} class="size-4 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: chip()?.background }}>
        <Text class="text-3xs font-semibold" style={{ color: chip()?.foreground }}>{accountInitials(account().email as string)}</Text>
      </View>
      : <Text class="min-w-0 truncate text-xs font-medium text-foreground">{providerLabel(account().driver)}</Text>;
}

function DetailRow(props: { label: string; children: any }) {
  return <View class="flex-row gap-3"><Text class="w-[4.5rem] text-xs text-muted-foreground">{props.label}</Text><Text class="min-w-0 flex-1 text-xs text-foreground tabular-nums">{props.children}</Text></View>;
}

/** SegmentPopover: who the segment is, its plan and where it is signed in, what is left and when it resets, and the credit action. */
function SegmentPopover(props: { account: PoolAccount; window: UsageLimitWindow; refill: number; restores: number | null; now: number; busy: boolean; onRedeem: () => void }) {
  const account = props.account;
  const remaining = remainingPercent(props.window);
  const timeLeft = paceRemainingPercent(props.window, props.now);
  const resetsIn = formatResetsIn(props.window, props.now);
  const where = account.environments.length > 0 ? account.environments.map((environment) => environment.label).join(", ") : account.sourceLabel ?? "";
  const credits = account.resetCredits && account.resetCredits.availableCount > 0 ? account.resetCredits : null;
  return <View class="w-72 gap-2.5 p-4" accessibilityLabel="Segment details">
    <View class="min-w-0 gap-0.5">
      <View class="flex-row items-center gap-2"><AccountAvatar account={account} /><Text class="min-w-0 truncate text-sm font-medium text-foreground">{accountName(account)}</Text></View>
      {account.email ? <RedactedSensitiveText value={account.email} ariaLabel="Toggle account email visibility" revealTooltip="Click to reveal email" hideTooltip="Click to hide email" class="w-fit" /> : null}
    </View>
    {account.plan || where ? <View class="gap-1 border-t border-border-60 pt-2.5">
      {account.plan ? <DetailRow label="Plan">{account.plan}</DetailRow> : null}
      {where ? <DetailRow label={account.environments.length > 0 ? "Signed in" : "Via"}>{where}</DetailRow> : null}
    </View> : null}
    <View class="gap-1 border-t border-border-60 pt-2.5">
      <DetailRow label="Left">{`${remaining}%`}</DetailRow>
      {props.window.resetsAt ? <DetailRow label="Resets">{`${formatUpcomingTimestamp(props.window.resetsAt, props.now)}${resetsIn ? ` · ${resetsIn.replace("resets in ", "in ")}` : ""}`}</DetailRow> : null}
      {timeLeft !== null ? <DetailRow label="Even pace">{`${timeLeft}% left by now`}</DetailRow> : null}
      {props.restores !== null && props.restores > 0 ? <DetailRow label="Restores">{`+${props.restores}% of pool`}</DetailRow> : null}
    </View>
    {credits ? <View class="flex-row items-center gap-3 border-t border-border-60 pt-2.5">
      <Text class="min-w-0 flex-1 text-xs text-muted-foreground tabular-nums">{resetCreditsSummary(credits, props.now, true)}</Text>
      <View role="button" accessibilityLabel={`Use reset for ${accountLabel(account)}`} disabled={props.busy} onPress={() => { if (!props.busy) props.onRedeem(); }}
        class={props.busy ? "h-6 flex-row items-center rounded-md border border-border px-2 opacity-50" : "h-6 flex-row items-center rounded-md border border-border px-2 hover:bg-accent"}>
        <Text class="text-xs text-foreground">{props.busy ? "Using…" : "Use reset"}</Text>
      </View>
    </View> : null}
  </View>;
}

interface Segment { account: PoolAccount; window: UsageLimitWindow; refill: number; restores: number | null }

function PoolBar(props: { pool: PoolWindow; color: string; now: () => number; active: () => string | null; setActive: (key: string | null, pinned: boolean) => void; busy: () => string | null; redeem: (account: PoolAccount) => void }) {
  const width = signal(0);
  const wide = () => width() >= WIDE_BAR;
  const restores = () => new Map(props.pool.resets.map((reset) => [reset.member.account.key, reset.restoresPercent]));
  const segments = (): Segment[] => props.pool.columns.flatMap((member) => member.window ? [{ account: member.account, window: member.window, refill: (member as { refillPercent: number }).refillPercent, restores: restores().get(member.account.key) ?? null }] : []);
  const keyOf = (segment: Segment) => `${props.pool.kind}:${props.pool.id}:${segment.account.key}`;
  return <View class="min-w-0 gap-1" onLayout={(event) => width.set(event.bounds.size.width)}>
    <View class="flex-row gap-1">
      <Each of={segments()} key={(segment) => keyOf(segment)}>{(segment, position) => {
        const anchor = createAnchor();
        const entry = () => segment();
        const remaining = () => remainingPercent(entry().window);
        const timeLeft = () => paceRemainingPercent(entry().window, props.now());
        const resetsIn = () => formatResetsIn(entry().window, props.now());
        const credits = () => entry().account.resetCredits?.availableCount ?? 0;
        const color = () => accentOf(entry().account.accentColor) ?? props.color;
        const many = () => segments().length > 1;
        const barWidth = signal(0);
        const mark = () => paceMark(timeLeft(), barWidth());
        const height = () => (wide() ? 32 : 20);
        return <View class="min-w-0 flex-1">
          <View ref={anchor.ref} role="button" onPress={() => props.setActive(keyOf(entry()), true)} onMouseEnter={() => props.setActive(keyOf(entry()), false)} onMouseLeave={() => props.setActive(null, false)}
            accessibilityLabel={`${accountLabel(entry().account)}: ${remaining()}% left${resetsIn() ? `, ${resetsIn()}` : ""}${timeLeft() === null ? "" : `, ${timeLeft()}% of the window left`}${credits() ? `, ${credits()} reset ${credits() === 1 ? "credit" : "credits"} banked` : ""}`}
            class={`relative min-w-0 overflow-hidden rounded-md ${props.active() === keyOf(entry()) ? "border border-border" : ""}`} style={{ height: height() }} onLayout={(event) => barWidth.set(event.bounds.size.width)}>
            {/* The track and fills share one layer so the pace slot cuts through all of them. */}
            <View class="absolute inset-0 overflow-hidden rounded-md bg-muted" style={mark() ? { maskImage: mark()!.mask } : undefined} accessibilityLabel="Segment track">
              {remaining() > 0 ? <View class="absolute inset-y-0 left-0 rounded-md" style={{ width: `${remaining()}%`, backgroundColor: fill(color()) }} /> : null}
              {remaining() < 100 && entry().restores !== null && entry().refill > 0
                ? <View class="absolute inset-y-0 right-0 overflow-hidden" style={{ width: `${Math.min(100 - remaining(), entry().refill)}%` }}><Hatch color={color()} height={height()} /></View> : null}
            </View>
            {mark() ? <View class="absolute inset-y-0.5 w-0.5 rounded-full bg-foreground" style={{ left: mark()!.tick - 1 }} accessibilityLabel="Even pace mark" /> : null}
            {wide()
              ? <View class="absolute inset-0 flex-row items-center gap-1.5 overflow-hidden rounded-md px-2">
                {many() ? <AccountName account={entry().account} /> : null}
                {many() ? <Text class="shrink-0 text-xs font-semibold text-foreground tabular-nums">{`${remaining()}%`}</Text> : null}
                {resetsIn() || credits() ? <View class="ml-auto flex-row items-center gap-1.5 overflow-hidden rounded-sm bg-background px-1.5 py-0.5">
                  <Text class="text-2xs text-foreground tabular-nums">{resetsIn()?.replace("resets in ", "↻ ") ?? ""}</Text>
                  {credits() ? <>
                    {resetsIn() ? <Text class="text-2xs text-muted-foreground">·</Text> : null}
                    <View class="flex-row items-center gap-0.5"><UsageIcon name="ticket" size={12} /><Text class="text-2xs font-semibold text-foreground tabular-nums">{String(credits())}</Text></View>
                  </> : null}
                </View> : null}
              </View>
              : <View class="absolute inset-0 items-center justify-center"><Text class="text-3xs font-semibold text-foreground tabular-nums">{String(position() + 1)}</Text></View>}
          </View>
          {props.active() === keyOf(entry()) ? <Popup animated anchor={anchor.anchor} placement="top" align="center" onClose={() => props.setActive(null, true)}>
            <SegmentPopover account={entry().account} window={entry().window} refill={entry().refill} restores={entry().restores} now={props.now()} busy={props.busy() === entry().account.key} onRedeem={() => { props.setActive(null, true); props.redeem(entry().account); }} />
          </Popup> : null}
        </View>;
      }}</Each>
    </View>
    {wide() ? null : <Each of={segments()} key={(segment) => `legend:${keyOf(segment)}`}>{(segment, position) => <View role="button" onPress={() => props.setActive(keyOf(segment()), true)} class="h-7 flex-row items-center gap-2 rounded-md px-1 hover:bg-accent">
      <View class="size-4 items-center justify-center rounded-sm" style={{ backgroundColor: fill(accentOf(segment().account.accentColor) ?? props.color) }}><Text class="text-3xs font-semibold text-foreground tabular-nums">{String(position() + 1)}</Text></View>
      <AccountName account={segment().account} />
      <Text class="shrink-0 text-xs font-semibold text-foreground tabular-nums">{`${remainingPercent(segment().window)}%`}</Text>
      <Text class="ml-auto shrink-0 text-2xs text-muted-foreground tabular-nums">{formatResetsIn(segment().window, props.now())?.replace("resets in ", "↻ ") ?? ""}</Text>
    </View>}</Each>}
  </View>;
}

function PoolWindowCard(props: { pool: PoolWindow; color: string; now: () => number; label?: string; description?: string; active: () => string | null; setActive: (key: string | null, pinned: boolean) => void; busy: () => string | null; redeem: (account: PoolAccount) => void }) {
  const nextRefill = () => props.pool.resets.find((reset) => reset.restoresPercent > 0);
  const pace = () => props.pool.pace;
  const timeLeft = () => props.pool.members.length === 1 ? paceRemainingPercent(props.pool.members[0]!.window, props.now()) : null;
  return <View class="flex-row items-center gap-6 rounded-lg border border-border-60 p-4" role="group"
    accessibilityLabel={`${props.label ?? props.pool.label}: ${props.pool.remainingPercent}% left${timeLeft() === null ? "" : `, ${timeLeft()}% of the window left`}`}>
    <View class="w-44 flex-col gap-1">
      <Text class="text-sm font-medium text-foreground">{props.label ?? props.pool.label}</Text>
      <View class="flex-row items-baseline gap-2">
        <Text class="text-3xl font-semibold text-foreground tabular-nums">{`${props.pool.remainingPercent}%`}</Text>
        <View class="flex-row items-center gap-2">
          <Text class="text-sm text-muted-foreground">left</Text>
          {pace() ? <View accessibilityLabel={PACE_DESCRIPTION[pace() ?? "on"].label}><UsageIcon name={PACE_DESCRIPTION[pace() ?? "on"].icon} size={14} /></View> : null}
        </View>
      </View>
      {nextRefill() && props.pool.columns.length > 1 ? <Text class="text-xs font-medium text-foreground tabular-nums">{`↻ +${nextRefill()?.restoresPercent}%`}</Text> : null}
    </View>
    <View class="min-w-0 flex-1 gap-3">
      <PoolBar pool={props.pool} color={props.color} now={props.now} active={props.active} setActive={props.setActive} busy={props.busy} redeem={props.redeem} />
      {props.description ? <Text class="text-xs text-muted-foreground">{props.description}</Text> : null}
    </View>
  </View>;
}

function PoolSection(props: { pool: LimitPool; now: () => number; active: () => string | null; setActive: (key: string | null, pinned: boolean) => void; busy: () => string | null; redeem: (account: PoolAccount) => void }) {
  const color = () => providerForDriver(props.pool.driver)?.color ?? "#d4d4d4";
  return <View class="flex-col gap-3">
    <View class="flex-row items-center gap-2">
      <ProviderIconView driver={props.pool.driver} name={providerLabel(props.pool.driver)} size={20} />
      <Text class="text-sm font-medium text-foreground">{providerLabel(props.pool.driver)}</Text>
    </View>
    <Each of={displayLimitWindows(props.pool)} key={(window) => `${window.kind}:${window.id}`}>{(window) => {
      const details = () => props.pool.driver === "cursor" ? cursorWindowDetails(window().id) : undefined;
      return <PoolWindowCard pool={window()} color={color()} now={props.now} label={details()?.label} description={details()?.description} active={props.active} setActive={props.setActive} busy={props.busy} redeem={props.redeem} />;
    }}</Each>
  </View>;
}

export function UsageLimitsSection(props: { accounts: () => UsageLimitAccount[]; /** The usage limit sources read, for a source that failed or reported no accounts. */ sources?: () => { id: string; label: string; error: string; accountCount: number; environmentLabel: string }[]; now: () => number; request?: LimitsRequest; openExternal?: (url: string) => void }) {
  const request = props.request ?? liveRequest;
  const open = props.openExternal ?? ((url: string) => { void openUrl(url); });
  /** One popover for the whole page: hovering or pressing another segment moves it instead of opening a second. */
  const active = signal<string | null>(null);
  const pinned = signal(false);
  const busy = signal<string | null>(null);
  const statuses = signal<Record<string, string>>({});
  const setActive = (key: string | null, pin: boolean) => {
    if (key === null) { if (!pin && pinned()) return; active.set(null); pinned.set(false); return; }
    if (!pin && pinned()) return;
    active.set(key); pinned.set(pin);
  };

  const poolAccounts = () => collectPoolAccounts(props.accounts());
  const pools = () => collectLimitPools(poolAccounts(), props.now());
  const environmentCount = () => new Set(props.accounts().map((account) => account.environmentId ?? "")).size;
  const notices = () => collectLimitNotices(props.accounts(), environmentCount(), props.sources?.() ?? []);
  const links = () => collectExternalUsageLinks(props.accounts());

  async function redeem(account: PoolAccount) {
    if (!account.redeem) return;
    // The popover closed before the confirm; progress and the outcome live under the pools.
    const confirmed = await confirm("Use a reset credit?\nThis redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.");
    if (!confirmed) return;
    const target = account.redeem;
    busy.set(account.key);
    statuses.update((all) => ({ ...all, [account.key]: "" }));
    const status = await redeemResetCredit((method, payload) => request(target.environmentId, method, payload), target.target);
    busy.set(null);
    statuses.update((all) => ({ ...all, [account.key]: status }));
  }
  const statusRows = () => poolAccounts().filter((account) => busy() === account.key || statuses()[account.key]);

  return (
    <View class="flex-col gap-8">
      {pools().length === 0 && notices().length === 0 && links().length === 0 ? (
        <Text class="text-sm text-muted-foreground">No provider on the selected environments reports subscription limits.</Text>
      ) : null}
      <Each of={pools()} key={(pool: LimitPool) => pool.driver}>{(pool) => <PoolSection pool={pool()} now={props.now} active={() => active()} setActive={setActive} busy={() => busy()} redeem={(account) => void redeem(account)} />}</Each>
      <Each of={statusRows()} key={(account: PoolAccount) => `status:${account.key}`}>{(account) => (
        <View class="flex-row items-center gap-2" accessibilityLabel="Reset credit status">
          <AccountName account={account()} />
          <Text class="text-xs text-muted-foreground">{busy() === account().key ? "Using reset credit…" : statuses()[account().key]}</Text>
        </View>
      )}</Each>
      <Each of={links()} key={(link) => link.url}>
        {(link) => (
          <View class="flex-row flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
            <View class="min-w-0 flex-1 flex-row items-center gap-3">
              {link().url === CHATGPT_USAGE_URL ? <ProviderIconView driver="codex" name="ChatGPT" size={24} /> : null}
              <View class="min-w-0 flex-1 flex-col gap-1">
                <Text class="text-sm font-medium text-foreground">{link().label}</Text>
                <Text class="text-xs text-muted-foreground">{link().accounts.join(", ")}</Text>
                {link().url === CHATGPT_USAGE_URL ? <Text class="text-xs text-muted-foreground">View usage in ChatGPT with your connected account.</Text> : link().message ? <Text class="max-w-xl text-xs text-muted-foreground">{link().message}</Text> : null}
              </View>
            </View>
            <View role="button" accessibilityLabel="Manage usage" onPress={() => open(link().url)} class="h-7 flex-row items-center gap-1.5 rounded-md px-2 hover:bg-accent">
              <Text class="text-xs text-muted-foreground">Manage usage</Text>
              <UsageIcon name="external-link" size={14} />
            </View>
          </View>
        )}
      </Each>
      {notices().length > 0 ? (
        <View role="alert" class="flex-row items-start gap-2 rounded-lg border border-warning bg-warning-surface px-3.5 py-3">
          <UsageIcon name="triangle-alert" size={16} />
          <View class="min-w-0 flex-1 gap-1">
            <Each of={notices()} key={(notice: string) => notice}>{(notice) => <Text class="text-sm font-medium text-warning-foreground">{notice()}</Text>}</Each>
          </View>
        </View>
      ) : null}
    </View>
  );
}
