import { mount, View } from "nsh";
import { applyConfigEventForTest, applyShellEventForTest, setBackendStatusForTest } from "../../store";
import { ScopeSentence } from "./ScopeSentence";

applyConfigEventForTest({ type: "snapshot", config: { environment: { environmentId: "environment-live", label: "legion" }, settings: {}, providers: [] } });
applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [], threads: [] } });
setBackendStatusForTest("connected");

mount(() => <View class="flex-1"><ScopeSentence single /></View>);
