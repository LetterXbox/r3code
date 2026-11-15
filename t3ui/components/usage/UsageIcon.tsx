// The few lucide marks the Usage page needs beyond the shared Icon set.
import { Image, View } from "nsh";
import { Icon } from "../Icons";
import check from "./icons/check.svg";
import chevronDown from "./icons/chevron-down.svg";
import circleAlert from "./icons/circle-alert.svg";
import gauge from "./icons/gauge.svg";
import trendingDown from "./icons/trending-down.svg";
import trendingUp from "./icons/trending-up.svg";
import plus from "./icons/plus.svg";
import rotateCcw from "./icons/rotate-ccw.svg";
import slidersHorizontal from "./icons/sliders-horizontal.svg";
import refreshCw from "./icons/refresh-cw.svg";
import externalLink from "./icons/external-link.svg";
import info from "./icons/info.svg";
import ticket from "./icons/ticket.svg";
import triangleAlert from "./icons/triangle-alert.svg";

const OWN: Record<string, typeof check> = { check, gauge, "trending-down": trendingDown, "trending-up": trendingUp, "chevron-down": chevronDown, "circle-alert": circleAlert, plus, "rotate-ccw": rotateCcw, "refresh-cw": refreshCw, "external-link": externalLink, info, ticket, "triangle-alert": triangleAlert, "sliders-horizontal": slidersHorizontal };

export function UsageIcon(props: { name: string; size?: number }) {
  const size = props.size ?? 16;
  const own = OWN[props.name];
  if (!own) return <Icon name={props.name} size={size} />;
  return <View style={{ width: size, height: size }}><Image src={own} style={{ width: size, height: size }} /></View>;
}
