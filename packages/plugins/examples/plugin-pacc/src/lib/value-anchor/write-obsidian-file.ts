/**
 * M1b write-mediator — T-2.4 (PRD § 9.6, tripwire 1 § 15.2).
 *
 * `writeObsidianFile` is the single function through which ALL agent writes
 * to the Obsidian vault flow. It rejects any write whose REAL target
 * (symlinks resolved) is a registry-listed value anchor, the registry note
 * itself, under a protected folder, or outside the vault entirely.
 *
 * Defensive posture (this is the safety boundary, so both checks err toward
 * rejection):
 *   - vault containment is CASE-SENSITIVE — a path that only matches the
 *     vault root by case-folding is not provably inside it;
 *   - protected-path matching is CASE-INSENSITIVE — the vault syncs to
 *     macOS/iCloud where "my world optics.MD" IS the anchor file.
 *
 * Every attempt emits `agent.m1b_write_attempt` with outcome
 * allowed/rejected — audit-everything, per spec.
 *
 * Allowed writes are idempotent + atomic (same behavior as the T-3.6 brief
 * writer): byte-identical content is a no-op (no mtime bump, no sync churn);
 * real writes go to a tmp sibling then rename.
 *
 * Pure domain logic per docs/substrate-firewall.md: event emission is
 * injected; node:fs is used directly because the module IS the filesystem
 * boundary (mocking it would test the mock — see the test file's rationale).
 */

import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ObsidianWriteResult {
  /** Absolute (real) path written or matched. */
  path: string;
  kind: "wrote" | "unchanged";
  byteLength: number;
}

export type ObsidianFileWriter = (
  targetPath: string,
  content: string,
) => Promise<ObsidianWriteResult>;

export interface ObsidianFileWriterDeps {
  /** Absolute path of the vault root. */
  vaultRoot: string;
  /**
   * Absolute paths that agents may never write: the registry note, every
   * resolved anchor note, and any protected folders. Re-fetched on every
   * call so a registry edit takes effect immediately.
   */
  getProtectedPaths(): Promise<string[]>;
  emitEvent(name: string, payload: Record<string, unknown>): Promise<void>;
}

export class M1bWriteAttemptError extends Error {
  readonly targetPath: string;
  readonly matchedProtectedPath: string | null;
  readonly reason: "protected_path" | "outside_vault";

  constructor(
    targetPath: string,
    reason: "protected_path" | "outside_vault",
    matchedProtectedPath: string | null,
  ) {
    super(
      reason === "outside_vault"
        ? `agent write rejected: ${targetPath} is outside the Obsidian vault`
        : `agent write rejected: ${targetPath} is M1b-protected (matches ${matchedProtectedPath})`,
    );
    this.name = "M1bWriteAttemptError";
    this.targetPath = targetPath;
    this.matchedProtectedPath = matchedProtectedPath;
    this.reason = reason;
  }
}

const M1B_WRITE_ATTEMPT_EVENT = "agent.m1b_write_attempt";

export function createObsidianFileWriter(deps: ObsidianFileWriterDeps): ObsidianFileWriter {
  return async function writeObsidianFile(targetPath, content) {
    const realVault = await realpathish(path.resolve(deps.vaultRoot));
    const resolvedTarget = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(deps.vaultRoot, targetPath);
    const realTarget = await realpathish(resolvedTarget);

    const reject = async (
      reason: "protected_path" | "outside_vault",
      matched: string | null,
    ): Promise<never> => {
      await deps.emitEvent(M1B_WRITE_ATTEMPT_EVENT, {
        outcome: "rejected",
        reason,
        targetPath: resolvedTarget,
        realTargetPath: realTarget,
        matchedProtectedPath: matched,
      });
      throw new M1bWriteAttemptError(resolvedTarget, reason, matched);
    };

    // 1. Vault containment — case-sensitive on the REAL path.
    if (realTarget !== realVault && !realTarget.startsWith(realVault + path.sep)) {
      return reject("outside_vault", null);
    }

    // 2. Protected-path match — case-insensitive on REAL paths.
    const realTargetFolded = realTarget.toLowerCase();
    for (const protectedPath of await deps.getProtectedPaths()) {
      const realProtected = (await realpathish(path.resolve(protectedPath))).toLowerCase();
      if (
        realTargetFolded === realProtected ||
        realTargetFolded.startsWith(realProtected + path.sep)
      ) {
        return reject("protected_path", protectedPath);
      }
    }

    // 3. Allowed → idempotent atomic write.
    const byteLength = Buffer.byteLength(content, "utf8");
    let kind: ObsidianWriteResult["kind"] = "wrote";
    try {
      const existing = await readFile(realTarget, "utf8");
      if (existing === content) kind = "unchanged";
    } catch (err) {
      if (!isMissingFile(err)) throw err;
    }

    if (kind === "wrote") {
      await mkdir(path.dirname(realTarget), { recursive: true });
      const tmpPath = `${realTarget}.tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(tmpPath, content, "utf8");
        await rename(tmpPath, realTarget);
      } catch (err) {
        await unlink(tmpPath).catch(() => undefined);
        throw err;
      }
    }

    await deps.emitEvent(M1B_WRITE_ATTEMPT_EVENT, {
      outcome: "allowed",
      targetPath: resolvedTarget,
      realTargetPath: realTarget,
      kind,
      byteLength,
    });
    return { path: realTarget, kind, byteLength };
  };
}

/**
 * realpath that tolerates not-yet-existing leaves: resolves the deepest
 * existing ancestor and re-appends the missing remainder. This is what
 * makes the symlink defense hold for new files inside symlinked dirs.
 */
async function realpathish(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (err) {
    if (!isMissingFile(err)) throw err;
    const parent = path.dirname(p);
    if (parent === p) throw err; // filesystem root missing — give up
    return path.join(await realpathish(parent), path.basename(p));
  }
}

function isMissingFile(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    ((err as { code?: string }).code === "ENOENT" ||
      (err as { code?: string }).code === "ENOTDIR")
  );
}
