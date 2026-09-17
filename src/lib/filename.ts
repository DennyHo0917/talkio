const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Produce a filename safe for Windows, macOS and Linux. */
export function sanitizeFilename(value: string, fallback = "conversation"): string {
  const cleaned = value
    .normalize("NFKC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows forbids U+0000–U+001F in file names.
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 50);
  if (!cleaned || cleaned === "." || cleaned === ".." || RESERVED_WINDOWS_NAMES.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}
