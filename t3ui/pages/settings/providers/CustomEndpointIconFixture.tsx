import { mount, View } from "nsh";
import { ProviderIconView } from "./ui";

mount(() => (
  <View class="flex-row gap-4 p-4">
    <ProviderIconView driver="openaiCompatible" name="Local LLM" size={24} />
    <View accessibilityLabel="small"><ProviderIconView driver="openaiCompatible" name="Groq Cloud" size={16} /></View>
  </View>
));
