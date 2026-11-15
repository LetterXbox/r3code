import { mount, View } from "nsh";
import { OfficeView } from "./OfficeView";
import { ODT_BASE64 } from "./officeFixtures";

const bytes = Uint8Array.from(atob(ODT_BASE64), (c) => c.charCodeAt(0));
mount(() => <View class="flex-1"><OfficeView cwd="" relativePath="t.odt" format="odt" readBytes={async () => bytes} /></View>);
