/** Constants for the import drawer. */

/** The only two things the parser accepts. From a .zip only .md is inflated. */
export const ACCEPTED_EXTENSIONS = [".md", ".zip"] as const;

/** `accept` attribute for the file input. */
export const FILE_ACCEPT = ACCEPTED_EXTENSIONS.join(",");

/** Imported bodies are untrusted, so they are created disabled until vetted. */
export const IMPORTED_ENABLED = false;
