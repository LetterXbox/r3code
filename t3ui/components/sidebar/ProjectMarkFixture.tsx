import { mount, View } from "nsh";
import { ProjectMark } from "./ProjectTile";

function Fixture() {
  return (
    <View class="w-[300px] gap-2 bg-sidebar p-2">
      <ProjectMark name="Derived Name" icon={null} src={null} />
      <ProjectMark name="Mono" icon={{ kind: "monogram", text: "QZ", color: "teal" }} src={null} />
      <ProjectMark name="Emoji" icon={{ kind: "emoji", emoji: "R" }} src={null} />
      <ProjectMark name="Lucide" icon={{ kind: "lucide", name: "rocket", color: "rose" }} src={null} />
      <ProjectMark name="Favicon" icon={null} src="https://127.0.0.1:1/api/assets/x.png" />
    </View>
  );
}

mount(Fixture);
