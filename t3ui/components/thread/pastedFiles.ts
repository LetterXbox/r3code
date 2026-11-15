/** Native paste can report the same image both as a File and as a file URL. */
export function distinctPastedPaths(fileNames: string[], uris: string[]): string[] {
  if (fileNames.length !== 1 || uris.length !== 1) return uris;
  try {
    const url = new URL(uris[0]);
    if (url.protocol !== "file:") return uris;
    const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    return name === fileNames[0] ? [] : uris;
  } catch {
    return uris;
  }
}
