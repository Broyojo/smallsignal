// The size limit and digest of an artifact's bytes, apart from ./files and
// its model and catalog imports, so the editor's artifact codec worker
// bundles only these (#1673).

/** The most bytes one artifact may hold. */
export const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
export { sha256 } from "./content-digest.js";
