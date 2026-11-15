import { mount, signal, Text, View } from "nsh";
import { ThemeColorPicker } from "./ThemeColorPicker";

const color = signal("#33669980");
mount(() => <View class="flex-1 items-center justify-center"><Text>{`Color: ${color()}`}</Text><ThemeColorPicker label="Background" value={color} onChange={(value) => color.set(value)} /></View>);
