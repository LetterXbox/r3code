// The pairing page alone, for its empty-token check.
import { mount, View } from "nsh";
import { PairingRouteSurface } from "./environments/StandalonePages";

mount(() => <View class="flex-1"><PairingRouteSurface /></View>);
