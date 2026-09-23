/* Extensions asked for by name: the wheels that install them.
 *
 * An extension index (extensions/index.json) names each extension's wheel, the extensions it
 * depends on and the SlicerWeb wheels it requires besides the startup ones (slicerweb-itk-extra,
 * say). `?extensions=SlicerHeart,SlicerIGT` on the address, or `extensions` in the runtime's
 * configuration, asks for extensions by those names, and they are installed at startup - with
 * what they depend on, in the order that needs - unless they already are.
 */
export interface ExtensionIndexEntry {
  name: string;
  wheel: string;
  depends?: string[];
  requires?: string[];
}

export interface ExtensionIndex {
  extensions: ExtensionIndexEntry[];
}

export const EXTENSIONS_KEY = "slicerweb.extensions";
export const EXTENSION_INDEX_KEY = "slicerweb.extensionIndex";

/** The extension index the Extensions Manager uses: one chosen there, else the application's own. */
export function extensionIndexUrl(): string {
  try {
    return localStorage.getItem(EXTENSION_INDEX_KEY) ?? new URL("extensions/index.json", document.baseURI).href;
  } catch {
    return new URL("extensions/index.json", document.baseURI).href;
  }
}

export async function loadExtensionIndex(url = extensionIndexUrl()): Promise<ExtensionIndex> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return { extensions: (await response.json()).extensions ?? [] };
}

/**
 * The wheels that install these extensions (names from the index, or wheel URLs as they are), in
 * installation order: what an extension requires and depends on comes before it, and nothing
 * twice. A name the index does not know is reported, not installed.
 */
export async function resolveExtensionWheels(
  wanted: string[],
  index: ExtensionIndex,
  indexUrl: string,
  baseWheelUrl: (name: string) => Promise<string | null>,
): Promise<{ wheels: string[]; unknown: string[] }> {
  const wheels: string[] = [];
  const unknown: string[] = [];
  const add = (url: string) => {
    if (!wheels.includes(url)) wheels.push(url);
  };
  const visiting = new Set<string>();
  const visit = async (name: string) => {
    if (/^(https?:)?\/\//.test(name) || /\.whl$/.test(name)) {
      add(new URL(name, document.baseURI).href);
      return;
    }
    const entry = index.extensions.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (!entry) {
      if (!unknown.includes(name)) unknown.push(name);
      return;
    }
    if (visiting.has(entry.name)) return; // a cycle in the index: what is in it is already on its way
    visiting.add(entry.name);
    for (const base of entry.requires ?? []) {
      const url = await baseWheelUrl(base);
      if (url) add(url);
      else if (!unknown.includes(base)) unknown.push(base);
    }
    for (const dependency of entry.depends ?? []) await visit(dependency);
    add(new URL(entry.wheel, indexUrl).href);
  };
  for (const name of wanted) await visit(name.trim());
  return { wheels, unknown };
}

/** The extensions asked for on the address: `?extensions=SlicerHeart,SlicerIGT`. */
export function extensionsFromAddress(search = location.search): string[] {
  const params = new URLSearchParams(search);
  return (params.get("extensions") ?? "").split(/[,;\s]+/).map((n) => n.trim()).filter(Boolean);
}
