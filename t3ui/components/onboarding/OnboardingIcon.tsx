// The few lucide marks the first-run page draws that components/Icons.tsx does not carry (check, plus, terminal).
import { Image, token } from "nsh";
import check from "../../icons/check.svg";
import plus from "../../icons/plus.svg";
import terminal from "../../icons/terminal.svg";

const MARKS = { check, plus, terminal } as const;

export function OnboardingIcon(props: { name: keyof typeof MARKS; size?: number; tint?: string }) {
  const size = props.size ?? 16;
  return <Image src={MARKS[props.name]} fadeDuration={0} style={{ width: size, height: size, tintColor: props.tint ?? token("muted-foreground") }} />;
}
