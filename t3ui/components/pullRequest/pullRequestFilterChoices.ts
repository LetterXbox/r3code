/** Merge loaded facets with host search results using the reference picker's ordering. */
export function pullRequestFilterChoices(
  facets: readonly { name: string }[],
  hosted: readonly string[],
  query: string,
  kind: "authors" | "labels",
  selected: readonly string[],
): { name: string }[] {
  const key = (name: string) => name.trim().toLowerCase();
  const needle = key(query);
  const loaded = facets.filter((facet) => key(facet.name).includes(needle));
  const known = new Map(facets.map((facet) => [key(facet.name), facet]));
  const seen = new Set(loaded.map((facet) => key(facet.name)));
  const extra: { name: string }[] = [];
  for (const name of hosted) {
    const normalized = key(name);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    extra.push(known.get(normalized) ?? { name });
  }
  const choices = kind === "authors" ? [...loaded.slice(0, 15), ...extra, ...loaded.slice(15)] : [...loaded, ...extra];
  const selectedKeys = new Set(selected.map(key));
  if (kind === "labels") {
    const choiceKeys = new Set(choices.map((choice) => key(choice.name)));
    return [...selected.filter((name) => !choiceKeys.has(key(name))).map((name) => ({ name })), ...choices];
  }
  const selectedChoices = selected.map((name) => known.get(key(name)) ?? { name });
  return [...selectedChoices, ...choices.filter((choice) => !selectedKeys.has(key(choice.name)))].slice(0, 30);
}
