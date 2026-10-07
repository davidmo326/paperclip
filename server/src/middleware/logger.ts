import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import pinoPretty from "pino-pretty";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { HTTP_LOG_REDACT_PATHS } from "./http-log-redaction.js";
import { redactSensitive, stripSecretBearingUrlParts } from "./redact-sensitive.js";
import { RotatingLogFile, readPositiveIntEnv } from "./rotating-log-file.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });

// Review 2026-10-07 F1: the legacy `server.log` holds unredacted bearer tokens
// and session cookies. New (redacted) output goes to a separate, rotated, 0600
// file so the legacy file is never appended to, renamed or rotated away by us.
const logFile = path.join(logDir, "paperclip-server.log");

const sharedOpts = {
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

const fileSink = new RotatingLogFile({
  file: logFile,
  maxBytes: readPositiveIntEnv("PAPERCLIP_LOG_MAX_BYTES", 20 * 1024 * 1024),
  maxFiles: readPositiveIntEnv("PAPERCLIP_LOG_MAX_FILES", 5),
  mode: 0o600,
});
const prettyForFile = pinoPretty.prettyFactory({ ...sharedOpts, colorize: false });

export const logger = pino(
  {
    level: "debug",
    redact: [...HTTP_LOG_REDACT_PATHS],
  },
  pino.multistream([
    {
      level: "info",
      stream: pino.transport({
        target: "pino-pretty",
        options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      }),
    },
    {
      level: "debug",
      stream: { write: (line: string) => fileSink.write(prettyForFile(line)) },
    },
  ]),
);

export function createHttpLogger(baseLogger: Logger) {
  return pinoHttp({
    logger: baseLogger,
    serializers: {
      req(req: Record<string, unknown> & { url?: unknown }) {
        return {
          ...req,
          url: typeof req.url === "string" ? stripSecretBearingUrlParts(req.url) : req.url,
          // The URL policy drops all query parameters; the default serializer
          // also exposes the parsed query separately, so omit that duplicate.
          query: undefined,
        };
      },
    },
    customLogLevel(_req, res, err) {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage(req, res) {
      return `${req.method} ${stripSecretBearingUrlParts(req.url ?? "")} ${res.statusCode}`;
    },
    customErrorMessage(req, res, err) {
      const ctx = (res as any).__errorContext;
      const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
      return `${req.method} ${stripSecretBearingUrlParts(req.url ?? "")} ${res.statusCode} — ${errMsg}`;
    },
    customProps(req, res) {
      if (res.statusCode >= 400) {
        const ctx = (res as any).__errorContext;
        if (ctx) {
          return {
            errorContext: ctx.error,
            reqBody: redactSensitive(ctx.reqBody),
            reqParams: redactSensitive(ctx.reqParams),
          };
        }
        const props: Record<string, unknown> = {};
        const { body, params } = req as any;
        if (body && typeof body === "object" && Object.keys(body).length > 0) {
          props.reqBody = redactSensitive(body);
        }
        if (params && typeof params === "object" && Object.keys(params).length > 0) {
          props.reqParams = redactSensitive(params);
        }
        if ((req as any).route?.path) {
          props.routePath = (req as any).route.path;
        }
        return props;
      }
      return {};
    },
  });
}

export const httpLogger = createHttpLogger(logger);
