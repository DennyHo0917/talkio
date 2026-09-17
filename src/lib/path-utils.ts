/** Normalize a user-supplied workspace-relative path without allowing escape. */
export function normalizeRelativePath(value: string): string | null {
  const raw = value.trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return null;
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}
