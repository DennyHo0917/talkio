import { describe, expect, it } from "vitest";
import { sanitizeFilename } from "../filename";
import { normalizeRelativePath } from "../path-utils";

describe("path and filename safety", () => {
  it("rejects traversal and absolute paths", () => {
    expect(normalizeRelativePath("src\\main.ts")).toBe("src/main.ts");
    expect(normalizeRelativePath("../secret.txt")).toBeNull();
    expect(normalizeRelativePath("src/../secret.txt")).toBeNull();
    expect(normalizeRelativePath("/etc/passwd")).toBeNull();
    expect(normalizeRelativePath("C:\\secret.txt")).toBeNull();
  });

  it("handles platform-reserved export names", () => {
    expect(sanitizeFilename("report: 2026?.md")).toBe("report_ 2026_.md");
    expect(sanitizeFilename("CON")).toBe("conversation");
    expect(sanitizeFilename("   ...   ")).toBe("conversation");
  });
});
