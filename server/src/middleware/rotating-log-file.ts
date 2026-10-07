import fs from "node:fs";

// Size-capped, rotating append-only log file (review 2026-10-07 F1).
//
// The previous server.log was a single 122 MB file at mode 664 that was never
// rotated. This sink writes synchronously (log volume is low: one personal
// instance), creates every file at `mode` (default 0600) regardless of umask,
// and when the active file would exceed `maxBytes` it shifts
// `<file>` -> `<file>.1` -> … -> `<file>.<maxFiles>` and drops anything older.
// It only ever touches `<file>` and `<file>.<n>`, never other files in the dir.

export interface RotatingLogFileOptions {
  file: string;
  maxBytes: number;
  /** Rotated files kept besides the active one. */
  maxFiles: number;
  mode?: number;
}

export class RotatingLogFile {
  private fd: number;
  private size: number;
  private readonly mode: number;

  constructor(private readonly opts: RotatingLogFileOptions) {
    if (!(opts.maxBytes > 0)) throw new Error("maxBytes must be > 0");
    if (!(opts.maxFiles >= 1)) throw new Error("maxFiles must be >= 1");
    this.mode = opts.mode ?? 0o600;
    this.fd = this.open();
    this.size = fs.fstatSync(this.fd).size;
  }

  private open(): number {
    const fd = fs.openSync(this.opts.file, "a", this.mode);
    // openSync's mode only applies on create (and is masked by umask): enforce it.
    fs.fchmodSync(fd, this.mode);
    return fd;
  }

  private rotate(): void {
    fs.closeSync(this.fd);
    this.fd = -1;
    const { file, maxFiles } = this.opts;
    fs.rmSync(`${file}.${maxFiles}`, { force: true });
    for (let i = maxFiles - 1; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
    this.fd = this.open();
    this.size = 0;
  }

  write(chunk: string | Buffer): boolean {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (this.size > 0 && this.size + buf.length > this.opts.maxBytes) {
      try {
        this.rotate();
      } catch {
        // Never let a rotation failure take the server down; keep appending.
        if (this.fd < 0) {
          this.fd = this.open();
          this.size = fs.fstatSync(this.fd).size;
        }
      }
    }
    fs.writeSync(this.fd, buf);
    this.size += buf.length;
    return true;
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // already closed
    }
  }
}

export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
