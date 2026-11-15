import { mount, View } from "nsh";
import { ProviderSubagentBar } from "./ProviderSubagentBar";

mount(() => <View class="w-full"><ProviderSubagentBar instanceId={() => ""} model={() => "example"} effort={() => "Low"} status={() => ({ status: "running", startedAt: null, completedAt: null })} onOpenParent={() => {}} /></View>);
