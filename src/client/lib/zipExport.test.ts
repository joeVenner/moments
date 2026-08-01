import { describe, expect, it } from "vitest";
import { safeArchiveName } from "./zipExport";

describe("safeArchiveName", () => {
  it("creates a portable archive filename", () => {
    expect(safeArchiveName("Sarah & Tom's Wedding 🎉")).toBe("Sarah-Tom-s-Wedding");
  });
});
