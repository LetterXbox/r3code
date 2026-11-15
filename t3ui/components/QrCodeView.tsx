// QRCodeSvg.tsx: a QR code, drawn as runs of dark modules on a white card (the web's
// `rounded-lg bg-white p-1.5` frame), from the vendored generator in qrCode.ts.
import { View } from "nsh";
import { QrCode } from "./qrCode";

const LEVELS = { L: QrCode.Ecc.LOW, M: QrCode.Ecc.MEDIUM, Q: QrCode.Ecc.QUARTILE, H: QrCode.Ecc.HIGH } as const;

/** The dark runs of each row as [row, start, length], so a code of 30 rows is a few dozen views. */
export function qrRuns(value: string, level: keyof typeof LEVELS = "M"): { size: number; runs: [number, number, number][] } {
  const code = QrCode.encodeText(value, LEVELS[level]);
  const runs: [number, number, number][] = [];
  for (let y = 0; y < code.size; y += 1) {
    let start = -1;
    for (let x = 0; x <= code.size; x += 1) {
      const dark = x < code.size && code.getModule(x, y);
      if (dark && start === -1) start = x;
      if (!dark && start !== -1) { runs.push([y, start, x - start]); start = -1; }
    }
  }
  return { size: code.size, runs };
}

export function QrCodeView(props: { value: string; size?: number; level?: keyof typeof LEVELS; marginSize?: number; title?: string }) {
  const total = props.size ?? 128;
  const margin = props.marginSize ?? 1;
  const { size, runs } = qrRuns(props.value, props.level ?? "M");
  const unit = total / (size + margin * 2);
  return (
    <View class="relative rounded-lg bg-white p-1.5" accessibilityLabel={props.title ?? "QR code"} style={{ width: total + 12, height: total + 12 }}>
      <View class="relative" style={{ width: total, height: total }}>
        {runs.map(([y, x, length]) => (
          <View class="absolute bg-black" style={{ left: (x + margin) * unit, top: (y + margin) * unit, width: length * unit, height: unit }} />
        ))}
      </View>
    </View>
  );
}
