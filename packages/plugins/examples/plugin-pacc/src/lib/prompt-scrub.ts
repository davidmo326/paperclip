/**
 * Prompt scrubber: David's data policy (2026-10-07). Journal and daily-note
 * text may reach a model provider only after secrets and personal identifiers
 * are removed, and nothing under `Secrets/`, no `*.env` and no `*.key` file is
 * ever read into a prompt.
 *
 * Each match becomes `[REDACTED:<type>]` (secret, email, phone, tfn, account,
 * card, address). The marker contains no hyphen, so the hallucination
 * tripwire's slug extractor can never mistake it for an ID.
 *
 * Exemptions, so the steward's grounding survives (review 2026-10-07 F9):
 * the generic "any 32+ char token run" rule would otherwise eat pacc UUIDs and
 * long vault paths. Before any rule runs, these spans are masked out:
 *   - canonical UUIDs (8-4-4-4-12 hex), the shape of every pacc entity id;
 *   - vault file references: a space-free run ending in .md/.canvas/.base;
 *   - exact strings the caller passes in `keep` (ids, card keys, paths and
 *     names taken from the structured fields of the same pack).
 * Callers scrub free-text fields only; structured fields are never touched.
 *
 * Limitation: pattern scrubbing does not catch personal names.
 */

export type RedactionType = "secret" | "email" | "phone" | "tfn" | "account" | "card" | "address";

const marker = (type: RedactionType) => `[REDACTED:${type}]`;

/** True for any path that must never be read into a prompt. */
export function isPromptDeniedPath(p: string): boolean {
  const segments = p.split(/[\\/]+/).filter(Boolean);
  if (segments.some((s) => s.toLowerCase() === "secrets")) return true;
  const base = (segments[segments.length - 1] ?? "").toLowerCase();
  return base.endsWith(".env") || base.startsWith(".env") || base.endsWith(".key");
}

// --- masking --------------------------------------------------------------
// Private-use code points: no rule below (\w, \d, \s, the 32+ class) matches
// them, so a masked span is invisible to every pattern until restored.
const MASK_OPEN = "";
const MASK_BASE = 0xe100;
const MASK_RE = /([-])/g;

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Anchored to the start of a run (never right after "@" or mid-run), so an
// address like someone@long-domain.md is not shielded as a "vault file".
const VAULT_FILE_RE = /(?<![@A-Za-z0-9+/_.-])[A-Za-z0-9+/_.-]{8,}\.(?:md|canvas|base)\b/gi;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- rules (order matters: specific before generic) ------------------------
const PEM_RE = /-----BEGIN [A-Z0-9 ]*KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*KEY-----|$)/g;
const SECRET_TOKEN_RES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bpcp_[A-Za-z0-9_]{12,}/g,
  /\btskey-[A-Za-z0-9-]{10,}/g,
];
const KEY_VALUE_RE = /\b(?:token|secret|password|passwd|api[_-]?key)\s*[:=]\s*\S+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;
const TFN_BEFORE_RE = /(\bTFN\b[^\d\n]{0,20})(\d{3}\s?\d{3}\s?\d{2,3})\b/gi;
const TFN_AFTER_RE = /\b\d{3}\s?\d{3}\s?\d{2,3}(?=[^\d\n]{0,20}\bTFN\b)/gi;
const PHONE_RES: RegExp[] = [
  /\+61[\s-]?\(?\d\)?(?:[\s-]?\d){8}\b/g,
  /\+\d{1,3}[\s-]?\d(?:[\s-]?\d){6,12}\b/g,
  /\b04\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g,
  /\(0\d\)\s?\d{4}[\s-]?\d{4}\b/g,
];
const BSB_RE = /\b\d{3}-\d{3}\b/g;
const ADDRESS_RE =
  /\b\d+[A-Za-z]?\s+\w+(?:\s\w+)?\s(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ct|Court|Pl|Place|Pde|Parade|Hwy|Lane|Ln|Cres|Crescent|Way|Blvd|Tce|Terrace)\b/g;
const LONG_RUN_RE = /[A-Za-z0-9+/_-]{32,}/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export interface ScrubOptions {
  /**
   * Exact id-like strings (entity ids, card keys, note paths) that must pass
   * through untouched. Do not pass plain words such as project names: a kept
   * word inside an email address would shield the address from redaction.
   */
  keep?: Iterable<string>;
}

/** Scrub one free-text value for a model prompt. */
export function scrubForPrompt(text: string, opts: ScrubOptions = {}): string {
  if (!text) return text;
  const masked: string[] = [];
  const mask = (s: string) => {
    if (masked.length >= 0xf8ff - MASK_BASE) return s; // absurdly many: stop masking
    masked.push(s);
    return MASK_OPEN + String.fromCharCode(MASK_BASE + masked.length - 1) + MASK_OPEN;
  };

  let out = text;
  // 1. Mask exempt spans: exact keep-strings (longest first), UUIDs, vault files.
  const keep = [...new Set([...(opts.keep ?? [])].filter((k) => typeof k === "string" && k.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  for (const k of keep) {
    if (out.includes(k)) out = out.replace(new RegExp(escapeRegExp(k), "g"), (m) => mask(m));
  }
  out = out.replace(UUID_RE, (m) => mask(m));
  out = out.replace(VAULT_FILE_RE, (m) => mask(m));

  // 2. Secrets.
  out = out.replace(PEM_RE, marker("secret"));
  for (const re of SECRET_TOKEN_RES) out = out.replace(re, marker("secret"));
  out = out.replace(KEY_VALUE_RE, marker("secret"));
  // 3. Personal identifiers.
  out = out.replace(EMAIL_RE, marker("email"));
  out = out.replace(CARD_RE, (m) => (luhnValid(m.replace(/[ -]/g, "")) ? marker("card") : m));
  out = out.replace(TFN_BEFORE_RE, (_m, lead: string) => `${lead}${marker("tfn")}`);
  out = out.replace(TFN_AFTER_RE, marker("tfn"));
  for (const re of PHONE_RES) out = out.replace(re, marker("phone"));
  out = out.replace(BSB_RE, marker("account"));
  out = out.replace(ADDRESS_RE, marker("address"));
  // 4. Generic long token runs (keys, hashes, tokens we have no pattern for).
  out = out.replace(LONG_RUN_RE, marker("secret"));

  // 5. Restore exempt spans.
  return out.replace(MASK_RE, (_m, ch: string) => masked[ch.charCodeAt(0) - MASK_BASE] ?? "");
}
