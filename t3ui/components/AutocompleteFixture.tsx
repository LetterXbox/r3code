// An Autocomplete over three hosts: the picked one is shown.
import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { AutocompleteItem, AutocompletePopup, createAutocomplete } from "./Autocomplete";

function AutocompleteFixture() {
  const query = signal("");
  const open = signal(false);
  const picked = signal("none");
  const items = () => ["devbox", "gpu-box", "staging"].filter((host) => host.includes(query()));
  const auto = createAutocomplete<string>({ items, open: () => open(), setOpen: (next) => open.set(next), onSelect: (host) => picked.set(host) });
  return (
    <View>
      <Text>{`picked=${picked()} open=${open()} highlighted=${auto.highlighted()}`}</Text>
      <Input accessibilityLabel="Host" value={query()} onChange={(e) => { query.set(e.value); auto.onType(); }} onFocus={auto.onFocus} onBlur={auto.onBlur} />
      {open() ? <AutocompletePopup label="Hosts">{items().map((host, index) => <AutocompleteItem label={host} highlighted={auto.highlighted() === index} onPress={() => auto.pick(host)}><Text>{host}</Text></AutocompleteItem>)}</AutocompletePopup> : null}
    </View>
  );
}
mount(AutocompleteFixture);
