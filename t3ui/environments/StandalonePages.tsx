// The reference's standalone route surfaces in the port's navigation model (no URL router, and the runtime has no
// open-URL event, so there is no deep-link entry). PairingRouteSurface (components/auth/PairingRouteSurface.tsx) shows,
// as the reference's root does, when the connected environment refused the session and wants a pairing credential;
// "Page not found" (routes/__root.tsx) shows for a navigation to a surface this client does not have.
import { Image, signal, Text, token, View } from "nsh";
import { createHover } from "../components/hoverReveal";
import { tokenAlpha } from "../components/composer/tokenColor";
import { DialogInput as Input } from "../components/DialogInput";
import { SettingsButton } from "../components/SettingsLayout";
import { useOverlayOpen } from "../components/rightPanel/nativeOcclusion";
import { backendError, backendStatus, backendUrl, configureBackend } from "../store";
import { record } from "../backend/client";
import wordmark from "../components/sidebar-wordmark.svg";

export const PAIRING_TOKEN_REQUIRED = "Enter a pairing token to continue.";
export const PAIRING_REQUIRED_ERROR = "Environment authorization expired. Enter a new pairing token.";

export function describeAuthGate(methods: readonly string[]): string {
  return methods.includes("desktop-bootstrap")
    ? "This environment expects a trusted pairing credential before the app can connect."
    : "Enter a pairing token to start a session with this environment.";
}

export function describeSupportedMethods(methods: readonly string[]): string {
  if (methods.includes("desktop-bootstrap") && methods.includes("one-time-token")) {
    return "Desktop-managed pairing and one-time pairing tokens are both accepted for this environment.";
  }
  if (methods.includes("desktop-bootstrap")) {
    return "This environment is desktop-managed. Open it from the desktop app or paste a bootstrap credential if one was issued explicitly.";
  }
  return "This environment accepts one-time pairing tokens. Pairing links can open this page directly, or you can paste the token here.";
}

/** The reference root shows the pairing surface when the session is unauthenticated; here, when the server refused it. */
export const pairingRequired = () => Boolean(backendUrl()) && backendStatus() === "error" && backendError() === PAIRING_REQUIRED_ERROR;

const notFound = signal(false);
/** Navigation to a surface this client does not have ends on "Page not found". */
export function showPageNotFound() { notFound.set(true); }
export const pageNotFoundShown = () => notFound();

async function readBootstrapMethods(socketUrl: string): Promise<string[]> {
  try {
    const url = new URL(socketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/api/auth/session"; url.search = ""; url.hash = "";
    const response = await fetch(url.toString());
    const methods = record(record(await response.json())?.auth)?.bootstrapMethods;
    return Array.isArray(methods) ? methods.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

// Card chrome matches apps/web/src/components/ui/standalone-page.tsx (StandalonePage: `max-w-xl rounded-2xl
// border p-6`, `dialog-glass` -> `bg-popover` here, no blur support) and StandalonePageHeader (wordmark + "Code",
// title `mt-6 text-xl font-semibold`, description `mt-2 text-sm text-muted-foreground`) -- the same pattern
// t3ui/shell/RootErrorView.tsx already uses for the root error card.
function StandalonePage(props: { title: string; description: string; children?: any }) {
  useOverlayOpen(() => true);
  return (
    <View class="absolute inset-0 z-30 flex-1 items-center justify-center bg-background px-6" accessibilityLabel={props.title}>
      <View class="w-full max-w-xl rounded-2xl border border-border bg-popover p-6">
        <View class="flex-row items-end gap-1.5">
          {/* T3Wordmark `h-3 text-foreground`, then "Code" `text-lg font-medium tracking-tight text-muted-foreground`. */}
          <Image src={wordmark} style={{ width: 20, height: 12, marginBottom: 7, tintColor: token("foreground") }} />
          <Text class="text-lg font-medium tracking-tight text-muted-foreground">Code</Text>
        </View>
        <Text class="mt-6 text-xl font-semibold leading-tight text-foreground" role="header">{props.title}</Text>
        <Text class="mt-2 text-sm text-muted-foreground">{props.description}</Text>
        {props.children}
      </View>
    </View>
  );
}

/** ui/button.tsx size "sm" (h-7, px 9, text-sm font-medium, rounded-lg): default is bg-primary with hover bg-primary/90,
 * outline is border-input on bg-popover with hover bg-accent/50; both scale to .97 while pressed. */
function PageButton(props: { label: string; primary?: boolean; disabled?: boolean; onPress: () => void }) {
  const hover = createHover();
  const fill = () => (props.primary ? (hover.hovered() && !props.disabled ? tokenAlpha("primary", 0.9) : token("primary")) : hover.hovered() && !props.disabled ? token("accent-50") : token("popover"));
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      {...hover.bind}
      style={{ backgroundColor: fill() }}
      class={`h-7 items-center justify-center rounded-lg px-[9px] active:scale-[0.97] transition-transform duration-150 ease-in-out ${props.primary ? "" : "border border-input"} ${props.disabled ? "opacity-64" : ""}`}
    >
      <Text class={`text-sm font-medium ${props.primary ? "text-primary-foreground" : "text-foreground"}`}>{props.label}</Text>
    </View>
  );
}

/** A credential this page submitted and whose exchange has not settled: the pending page shows while it connects,
 * and a failed exchange brings the pairing page back with its error (PairingRouteSurface's `errorMessage`). */
const pairingSubmitted = signal(false);
/** errorMessageFromUnknown over the exchange's error. A refused credential (HTTP 401/403 from /oauth/token) reads as the
 * web's PrimaryEnvironmentPairingCredentialRejectedError; anything else falls back to its message. */
export function pairingErrorMessage(error: string | null | undefined): string {
  if (error && /HTTP 40[13]\b/.test(error)) return "Invalid pairing token. Check the token and try again.";
  return error && error.trim() ? error : "Authentication failed.";
}
const pairingSubmitError = () => pairingErrorMessage(backendError());

/** PairingPendingSurface: the reference shows it while the pairing route validates its credential. */
export function PairingPendingSurface() {
  return <StandalonePage title="Pairing with this environment" description="Validating the pairing link and preparing your session." />;
}

/** Alert variant "error": `rounded-xl border border-error/32 bg-error-surface px-3.5 py-3 text-sm`, description
 * text-error-foreground/80. */
function ErrorAlert(props: { message: string }) {
  return (
    <View role="alert" class="rounded-xl border px-3.5 py-3 bg-error-surface" style={{ borderColor: tokenAlpha("error", 0.32) }}>
      <Text class="text-sm" style={{ color: tokenAlpha("error-foreground", 0.8) }}>{props.message}</Text>
    </View>
  );
}

export function PairingRouteSurface(props: { errorMessage?: string } = {}) {
  const credential = signal("");
  const submitting = signal(false);
  const methods = signal<string[]>([]);
  void readBootstrapMethods(backendUrl()).then((list) => methods.set(list));
  const emptyError = signal<string | null>(null);
  const submit = () => {
    if (submitting()) return;
    // PrimaryEnvironmentPairingCredentialRequiredError: an empty token is refused before any exchange.
    if (credential().trim().length === 0) { emptyError.set(PAIRING_TOKEN_REQUIRED); return; }
    emptyError.set(null);
    submitting.set(true);
    pairingSubmitted.set(true);
    configureBackend(backendUrl(), credential());
    setTimeout(() => submitting.set(false), 0);
  };
  return (
    <StandalonePage title="Pair with this environment" description={describeAuthGate(methods())}>
      <View class="mt-6 gap-4">
        <View class="gap-2">
          <Text class="text-sm font-medium text-foreground">Pairing token</Text>
          <Input accessibilityLabel="Pairing token" value={credential()} placeholder="Paste a one-time token or pairing secret" autoCapitalize="none" autoCorrect={false}
            disabled={submitting()} onChange={(event) => credential.set(event.value)} onSubmit={submit}
            class="h-8 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground" />
        </View>
        {emptyError() ?? props.errorMessage ? <ErrorAlert message={(emptyError() ?? props.errorMessage)!} /> : null}
        <View class="flex-row flex-wrap gap-2">
          <PageButton primary label={submitting() ? "Pairing..." : "Continue"} disabled={submitting()} onPress={submit} />
          <PageButton label="Reload app" disabled={submitting()} onPress={() => configureBackend(backendUrl())} />
        </View>
      </View>
      {/* `rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground`. */}
      <View class="mt-6 rounded-lg border border-border-70 px-3 py-3" style={{ backgroundColor: tokenAlpha("background", 0.55) }}>
        <Text class="text-xs leading-relaxed text-muted-foreground">{describeSupportedMethods(methods())}</Text>
      </View>
    </StandalonePage>
  );
}

export function PageNotFoundSurface() {
  return (
    <StandalonePage title="Page not found" description="This link doesn't point to a page in R3 Code. Go home to choose a project or start a thread.">
      <View class="mt-6 flex-row">
        <SettingsButton label="Go home" onPress={() => notFound.set(false)} />
      </View>
    </StandalonePage>
  );
}

export function StandalonePagesHost() {
  return () => {
    if (pairingSubmitted()) {
      const status = backendStatus();
      if (status === "connecting") return <PairingPendingSurface />;
      if (status === "error") return <PairingRouteSurface errorMessage={pairingRequired() ? undefined : pairingSubmitError()} />;
      if (status === "connected") queueMicrotask(() => pairingSubmitted.set(false));
    }
    return pairingRequired() ? <PairingRouteSurface /> : pageNotFoundShown() ? <PageNotFoundSurface /> : null;
  };
}
