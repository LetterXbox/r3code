import { mount, signal, Text, View } from "nsh";
import { UserInputPanel, type UserInputDisplay } from "./UserInputPanel";

const requests = signal<UserInputDisplay[]>([{
  id: "question-1",
  title: "Input requested",
  questions: [
    {
      id: "choices", header: "Features", question: "Which should be included?", multiSelect: true,
      allowCustomAnswer: false, required: true,
      options: [{ label: "Tests", description: "Run checks", value: "test-value" }, { label: "Docs", description: "Update documentation" }],
    },
    { id: "note", header: "Note", question: "Anything else?", options: [], multiSelect: false, allowCustomAnswer: true, required: true },
  ],
}, {
  id: "question-2",
  title: "Input requested",
  dismissible: true,
  questions: [{ id: "mode", header: "Mode", question: "Which mode?", multiSelect: false, allowCustomAnswer: false, required: true, options: [{ label: "Fast", description: "Quick pass" }, { label: "Thorough", description: "Slow pass" }] }],
}]);
const submitted = signal("");
const visible = signal(true);

function Fixture() {
  return (
    <View>
      {visible() ? <UserInputPanel scope={() => "fixture"} requests={requests} onDismiss={async (id) => {
        submitted.set(`dismissed:${id}`);
        requests.update((current) => current.filter((request) => request.id !== id));
      }} onRespond={async (id, answers) => {
        submitted.set(JSON.stringify(answers));
        requests.update((current) => current.filter((request) => request.id !== id));
      }} /> : null}
      <View accessibilityLabel="Toggle questions" onPress={() => visible.update((current) => !current)}>
        <Text>Toggle questions</Text>
      </View>
      <Text>{submitted()}</Text>
    </View>
  );
}

mount(Fixture);
