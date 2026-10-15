/**
 * The Files tab's tree, built from the workspace listing the host returns. Pure: no React and no fetching, so the shapes
 * and the filtering are unit tested.
 */
export type FileKind = "markdown" | "image" | "text";

export interface TreeFile { name: string; path: string }
export interface TreeFolder { name: string; path: string; folders: TreeFolder[]; files: TreeFile[] }

/** The raster formats the host serves in raw mode; anything else is shown as text (or refused by the host). */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

const extensionOf = (name: string): string => /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";

/** How the viewer should render a file: the host decides what it can be read as, this decides how to show it. */
export function fileKind(name: string): FileKind {
  const extension = extensionOf(name);
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  return IMAGE_EXTENSIONS.has(extension) ? "image" : "text";
}

const folder = (name: string, path: string): TreeFolder => ({ name, path, folders: [], files: [] });
/** Case-insensitive order, with a case-sensitive tiebreak so the order never depends on the host's locale. */
const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const segmentsOf = (path: string): string[] => path.split("/").filter((segment) => segment !== "");

function sortTree(node: TreeFolder): void {
  node.folders.sort(byName);
  node.files.sort(byName);
  for (const child of node.folders) sortTree(child);
}

/** The listing as a tree: folders before files at every level, duplicates and non-file entries ignored. */
export function buildTree(paths: readonly string[]): TreeFolder {
  const root = folder("", "");
  const folders = new Map<string, TreeFolder>([["", root]]);
  const seen = new Set<string>();
  for (const raw of paths) {
    // A trailing slash names a directory, and the listing carries files only.
    if (raw.endsWith("/")) continue;
    const segments = segmentsOf(raw);
    if (!segments.length) continue;
    const path = segments.join("/");
    if (seen.has(path)) continue;
    seen.add(path);
    let parent = root;
    for (let index = 0; index < segments.length - 1; index++) {
      const childPath = segments.slice(0, index + 1).join("/");
      let child = folders.get(childPath);
      if (!child) {
        child = folder(segments[index]!, childPath);
        folders.set(childPath, child);
        parent.folders.push(child);
      }
      parent = child;
    }
    parent.files.push({ name: segments.at(-1)!, path });
  }
  sortTree(root);
  return root;
}

export function countFiles(tree: TreeFolder): number {
  return tree.files.length + tree.folders.reduce((total, child) => total + countFiles(child), 0);
}

/** The folders a file sits under, outermost first: `a/b/c.ts` -> `["a", "a/b"]`. */
export function ancestorFolders(path: string): string[] {
  const segments = segmentsOf(path);
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
}

/** A blank query is not a filter: the same tree comes back. Otherwise matching files keep their ancestors. */
export function filterTree(tree: TreeFolder, query: string): TreeFolder {
  const needle = query.trim().toLowerCase();
  if (!needle) return tree;
  const keep = (node: TreeFolder): TreeFolder | undefined => {
    const folders = node.folders.map(keep).filter((child): child is TreeFolder => child !== undefined);
    const files = node.files.filter((file) => file.path.toLowerCase().includes(needle));
    if (!folders.length && !files.length) return undefined;
    return { name: node.name, path: node.path, folders, files };
  };
  return keep(tree) ?? folder("", "");
}
