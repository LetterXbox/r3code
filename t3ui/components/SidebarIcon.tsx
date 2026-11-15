import { token } from "nsh";
import { Icon } from "./Icons";

export function SidebarIcon(props: { name: string; size?: number }) {
  return <Icon name={props.name} size={props.size} tint={token("sidebar-muted-foreground")} />;
}
