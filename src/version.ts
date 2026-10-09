import manifest from "../package.json" with { type: "json" };

/** The published package version, read from package.json at build time. */
export const VERSION: string = manifest.version;
