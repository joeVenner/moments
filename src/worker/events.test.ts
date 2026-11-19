import { describe, expect, it } from "vitest";
import { fromSqlTimestamp, sqlTimestamp } from "./events";

describe("fromSqlTimestamp", () => {
  it("reads stored timestamps as UTC and refuses anything else", () => {
    expect(fromSqlTimestamp("2026-12-20 10:00:00")).toEqual(new Date("2026-12-20T10:00:00Z"));
    expect(() => fromSqlTimestamp("2026-12-20T10:00:00Z")).toThrow();
    expect(() => fromSqlTimestamp("")).toThrow();
  });
});

describe("sqlTimestamp", () => {
  it("round-trips through fromSqlTimestamp at whole seconds", () => {
    const date = new Date("2026-12-20T10:00:00.999Z");
    expect(fromSqlTimestamp(sqlTimestamp(date))).toEqual(new Date("2026-12-20T10:00:00Z"));
  });
});
