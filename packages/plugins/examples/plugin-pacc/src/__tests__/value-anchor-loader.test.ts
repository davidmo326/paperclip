/**
 * T-2.4 — value-anchor registry loader tests.
 *
 * The registry note (`[[Value Anchors]]`, principal-authored, T-0.7) lists
 * which vault notes are M1b value anchors. The loader must:
 *   - parse ONLY the `## Registry` section's `- [[wikilink]] — purpose` lines
 *     (PLAN v3 amendment: ignore "How to use this note" / "Notes for future-me")
 *   - resolve wikilinks vault-wide by note basename
 *   - surface unresolvable wikilinks as warnings, never throw
 *   - produce § 9.6 citations via valueAnchorCite (format pinned in
 *     ControlPlane/docs/value-anchor-citation-format.md)
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  loadValueAnchors,
  parseValueAnchorCitation,
  validateValueAnchorCitation,
  valueAnchorCite,
  type ValueAnchorLoaderDeps,
} from "../lib/value-anchor/loader.js";

const REGISTRY_NOTE = `# Value Anchors

This note is the **M1b registry** for the pacc steward.

## How to use this note

- **Add an anchor:** add a line below.
- Decoy link that is NOT an anchor: [[How-to Decoy]].

## Registry

- [[The three jobs of a solo entrepreneur]] — operating priority hierarchy
- [[Zone 2 entrepreneurship]] — operating discipline
- [[Nested Anchor Note]] — lives in a subfolder
- [[Ghost Note]] — listed but file does not exist

## Notes for future-me

- Another decoy: [[Future Decoy]] should never become an anchor.
`;

function makeDeps(overrides?: Partial<ValueAnchorLoaderDeps>): ValueAnchorLoaderDeps {
  const files: Record<string, string> = {
    "/vault/Value Anchors.md": REGISTRY_NOTE,
    "/vault/The three jobs of a solo entrepreneur.md": "# Jobs\ncontent",
    "/vault/Zone 2 entrepreneurship.md": "# Zone 2\ncontent",
    "/vault/30_Principles/Nested Anchor Note.md": "# Nested\ncontent",
    "/vault/How-to Decoy.md": "decoy",
    "/vault/Future Decoy.md": "decoy",
  };
  return {
    vaultRoot: "/vault",
    async readFile(absPath: string) {
      const content = files[absPath];
      if (content === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return content;
    },
    async listMarkdownFiles() {
      return Object.keys(files);
    },
    ...overrides,
  };
}

describe("loadValueAnchors", () => {
  it("parses only the ## Registry section (decoys in other sections are not anchors)", async () => {
    const { anchors } = await loadValueAnchors(makeDeps());
    const names = anchors.map((a) => a.name);
    expect(names).toEqual([
      "The three jobs of a solo entrepreneur",
      "Zone 2 entrepreneurship",
      "Nested Anchor Note",
      "Ghost Note",
    ]);
    expect(names).not.toContain("How-to Decoy");
    expect(names).not.toContain("Future Decoy");
  });

  it("captures the purpose text after the em-dash", async () => {
    const { anchors } = await loadValueAnchors(makeDeps());
    expect(anchors[0]?.purpose).toBe("operating priority hierarchy");
  });

  it("resolves wikilinks vault-wide, including subfolders", async () => {
    const { anchors } = await loadValueAnchors(makeDeps());
    const nested = anchors.find((a) => a.name === "Nested Anchor Note");
    expect(nested?.resolved).toBe(true);
    expect(nested?.path).toBe("/vault/30_Principles/Nested Anchor Note.md");
  });

  it("surfaces unresolvable wikilinks as warnings without throwing", async () => {
    const { anchors, warnings } = await loadValueAnchors(makeDeps());
    const ghost = anchors.find((a) => a.name === "Ghost Note");
    expect(ghost?.resolved).toBe(false);
    expect(ghost?.path).toBeNull();
    expect(warnings.some((w) => w.includes("Ghost Note"))).toBe(true);
  });

  it("discovers the registry note vault-wide when it is not at the vault root (real T-0.7 placement)", async () => {
    // The principal authored the note at 10_Builds/Personal AI Control Plane/,
    // not the vault root — discovery must work regardless of folder.
    const files: Record<string, string> = {
      "/vault/10_Builds/Personal AI Control Plane/Value Anchors.md": REGISTRY_NOTE,
      "/vault/The three jobs of a solo entrepreneur.md": "# Jobs\ncontent",
      "/vault/Zone 2 entrepreneurship.md": "# Zone 2\ncontent",
      "/vault/30_Principles/Nested Anchor Note.md": "# Nested\ncontent",
    };
    const deps: ValueAnchorLoaderDeps = {
      vaultRoot: "/vault",
      async readFile(absPath: string) {
        const content = files[absPath];
        if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return content;
      },
      async listMarkdownFiles() {
        return Object.keys(files);
      },
    };
    const { anchors, warnings, registryPath } = await loadValueAnchors(deps);
    expect(registryPath).toBe("/vault/10_Builds/Personal AI Control Plane/Value Anchors.md");
    expect(anchors.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("not found"))).toBe(false);
  });

  it("returns the registry path used, so the mediator protects the real location", async () => {
    const { registryPath } = await loadValueAnchors(makeDeps());
    expect(registryPath).toBe("/vault/Value Anchors.md");
  });

  it("returns empty anchors + a warning when the registry note is missing", async () => {
    const deps = makeDeps({
      async readFile() {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    const { anchors, warnings } = await loadValueAnchors(deps);
    expect(anchors).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("valueAnchorCite", () => {
  const NOTE = `# The three jobs of a solo entrepreneur

Intro paragraph.

## Job 1 boundary rule

Do not build until you have money in the bank.

## Job 2

Distribution content.
`;

  it("produces the pinned format: [[Name]] § Section @ hash8", () => {
    const sectionText = "Do not build until you have money in the bank.";
    const expectedHash = createHash("sha256").update(sectionText, "utf8").digest("hex").slice(0, 8);
    const cite = valueAnchorCite(
      "The three jobs of a solo entrepreneur",
      NOTE,
      "Job 1 boundary rule",
    );
    expect(cite).toBe(
      `[[The three jobs of a solo entrepreneur]] § Job 1 boundary rule @ ${expectedHash}`,
    );
  });

  it("hashes only the section body (between the heading and the next equal-or-higher heading)", () => {
    const cite1 = valueAnchorCite("N", NOTE, "Job 1 boundary rule");
    const cite2 = valueAnchorCite("N", NOTE.replace("Distribution content.", "changed"), "Job 1 boundary rule");
    // Editing a DIFFERENT section must not change this section's hash.
    expect(cite1).toBe(cite2);
  });

  it("throws for a missing section heading", () => {
    expect(() => valueAnchorCite("N", NOTE, "No Such Section")).toThrow(/section/i);
  });
});

describe("validateValueAnchorCitation (T-2.10 Part B)", () => {
  const anchors = new Set([
    "the three jobs of a solo entrepreneur",
    "zone 2 entrepreneurship",
  ]);

  it("accepts a well-formed citation whose name is registered (case-insensitive)", () => {
    const cite = "[[The Three Jobs of a Solo Entrepreneur]] § Job 1 boundary rule @ a3f9c2d1";
    expect(validateValueAnchorCitation(cite, anchors)).toEqual({ valid: true });
  });

  it("rejects a name that isn't a registered anchor", () => {
    const cite = "[[Some Made-Up Anchor]] § Section @ a3f9c2d1";
    const r = validateValueAnchorCitation(cite, anchors);
    expect(r.valid).toBe(false);
    expect(r.valid === false && r.reason).toMatch(/not a registered value anchor/);
  });

  it("rejects citations missing the section or hash", () => {
    expect(validateValueAnchorCitation("[[Zone 2 entrepreneurship]]", anchors).valid).toBe(false);
    expect(validateValueAnchorCitation("[[Zone 2 entrepreneurship]] § Litmus tests", anchors).valid).toBe(false);
  });

  it("rejects a hash that isn't exactly 8 hex chars", () => {
    expect(
      validateValueAnchorCitation("[[Zone 2 entrepreneurship]] § S @ a3f9c2d100", anchors).valid,
    ).toBe(false); // 10 chars
    expect(
      validateValueAnchorCitation("[[Zone 2 entrepreneurship]] § S @ zzzzzzzz", anchors).valid,
    ).toBe(false); // non-hex
  });

  it("accepts sub-section syntax (›) in the section", () => {
    const cite = "[[Zone 2 entrepreneurship]] § Weekly ritual › Did I build for return @ 7e8b1934";
    expect(validateValueAnchorCitation(cite, anchors)).toEqual({ valid: true });
  });

  it("parseValueAnchorCitation returns null for non-citations", () => {
    expect(parseValueAnchorCitation("per the principal's values")).toBeNull();
    expect(parseValueAnchorCitation("[[Value Anchors]] § The three jobs")).toBeNull();
  });
});
