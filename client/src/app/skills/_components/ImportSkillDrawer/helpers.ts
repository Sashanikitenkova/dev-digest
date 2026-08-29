import { ACCEPTED_EXTENSIONS } from "./constants";

/** True when `filename` is one the server-side parser will accept. */
export function isSupportedSkillFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Read a picked File to base64 in the browser.
 *
 * The import endpoint takes `{ filename, content_base64 }` as plain JSON — not
 * multipart — so the server keeps its Zod body-validation convention and needs
 * no extra dependency. `readAsDataURL` gives `data:<mime>;base64,<payload>`;
 * we keep only the payload.
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}
