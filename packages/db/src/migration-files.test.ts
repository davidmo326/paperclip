import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isForwardMigrationFile } from "./client.js";

describe("migration file selection (review 2026-10-07 F2)", () => {
  it("skips manual down/rollback scripts", () => {
    expect(isForwardMigrationFile("0047_pacc_decisions_authority.sql")).toBe(true);
    expect(isForwardMigrationFile("0047_pacc_decisions_authority_down.sql")).toBe(false);
    expect(isForwardMigrationFile("0048_x_DOWN.sql")).toBe(false);
    expect(isForwardMigrationFile("_journal.json")).toBe(false);
  });

  it("keeps no down scripts in the migrations folder", () => {
    const names = readdirSync(new URL("./migrations/", import.meta.url));
    expect(names.filter((n) => /_down\.sql$/i.test(n))).toEqual([]);
  });
});
