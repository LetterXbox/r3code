import { mount, View } from "nsh";
import { DeviceToolVersions } from "./DeviceToolVersions";

const tools = { hub: { runningVersion: null, requiredVersion: "0.12.0", installedVersions: ["0.9.0", "0.12.0"] }, agent: { runningVersion: "1.4.2", requiredVersion: "1.4.0", installedVersions: [] } };

mount(() => (
    <View class="flex-1 gap-4 p-4">
      <DeviceToolVersions kind="hub" tools={tools} owner="Acme IT" />
      <DeviceToolVersions kind="agent" tools={undefined} />
    </View>
));
