// DeviceHostAvailability.tsx (components/device/DeviceHostAvailability.tsx): the "iOS available / Android unavailable"
// line a successful host connection check shows, each platform with its reason as a tooltip.
import { Text, View } from "nsh";
import { DIcon } from "./DeviceIcons";

export type DevicePlatformAvailability = { platform: "ios" | "android"; available: boolean; reason?: string };

/** The line's text for one platform. */
export function availabilityLabel(platform: DevicePlatformAvailability): string {
  return `${platform.platform === "ios" ? "iOS" : "Android"} ${platform.available ? "available" : "unavailable"}`;
}

/** The tooltip: the host's reason, else the platform's plain "available". */
export function availabilityTip(platform: DevicePlatformAvailability): string {
  return platform.reason ?? (platform.platform === "ios" ? "iOS available" : "Android available");
}

export function DeviceHostAvailability(props: { platforms: ReadonlyArray<DevicePlatformAvailability> }) {
  return (
    <View class="flex-row flex-wrap gap-x-4 gap-y-1">
      {props.platforms.map((platform) => (
        <View tooltip={availabilityTip(platform)} accessibilityLabel={availabilityLabel(platform)} class="flex-row items-center gap-1">
          <DIcon name={platform.available ? "check" : "minus"} size={12} />
          <Text class="text-xs text-muted-foreground">{availabilityLabel(platform)}</Text>
        </View>
      ))}
    </View>
  );
}
