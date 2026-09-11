/**
 * Pure path helpers for Coilbox rules.
 *
 * Oxlint runs plugin code in a bare JS sandbox, so these avoid `node:path`. Paths are compared by
 * repository-relative suffix rather than absolute prefix, which keeps the rules correct whether
 * Oxlint is invoked from the repository root or from a subdirectory.
 */

/** Normalize a filesystem path to forward slashes without touching its segment structure. */
export function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * True when `filename` is exactly the repository-relative `relativePath`.
 *
 * The leading-slash check prevents `src/editor` from matching `src/not-editor` and prevents
 * `src/runtime/x.ts` from matching `a/src/runtime/x.ts`.
 */
export function isRepoFile(filename: string, relativePath: string): boolean {
  const normalized = toPosix(filename);
  const suffix = `/${relativePath}`;
  return normalized === relativePath || normalized.endsWith(suffix);
}

/** True when `filename` lives anywhere under the repository-relative directory `relativeDir`. */
export function isRepoDirectory(filename: string, relativeDir: string): boolean {
  const normalized = toPosix(filename);
  const marker = `/${relativeDir.replace(/\/+$/u, "")}/`;
  return normalized.startsWith(relativeDir) || normalized.includes(marker);
}

/**
 * Resolve a relative import specifier against the importing file's directory.
 *
 * Returns `null` when the specifier is bare (a package) or absolute, because those cannot point at
 * a repository-internal directory and so cannot violate a layering rule.
 */
export function resolveRelativeSpecifier(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;

  const segments = toPosix(importer).split("/");
  segments.pop();

  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.join("/");
}
