import documentAsset from "./terminalDocument.svg";

let cached: Promise<string> | undefined;

/** Tests give the renderer page themselves (a headless run cannot fetch the bundled asset); null goes back to the asset. */
export function overrideTerminalDocument(html: string | null) {
  cached = html === null ? undefined : Promise.resolve(html);
}

export function loadTerminalDocument(): Promise<string> {
  if (!cached) {
    cached = fetch(documentAsset.url).then(async (response) => {
      if (!response.ok) throw new Error("Could not load the terminal renderer");
      const asset = await response.text();
      // The page is 2.5 MB: no regex over the asset and no per-character array (Uint8Array.from with a mapper peaked at
      // ~200 MB of the 256 MB JS heap); slice the payload out and fill one preallocated byte array.
      const start = asset.indexOf("<metadata>");
      const end = start < 0 ? -1 : asset.indexOf("</metadata>", start);
      if (start < 0 || end < 0) throw new Error("The terminal renderer asset is invalid");
      const binary = atob(asset.slice(start + "<metadata>".length, end));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return new TextDecoder().decode(bytes);
    }).catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
  }
  return cached;
}
