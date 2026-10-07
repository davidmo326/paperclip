// pino `redact` paths for HTTP request/response logging. Ported from upstream
// paperclip (server/src/middleware/http-log-redaction.ts) plus the fork's own
// credential-bearing headers. Review 2026-10-07 F1: board API keys
// (`Authorization: Bearer pcp_board_…`) and the better-auth session cookie
// were being written to server.log verbatim.
export const HTTP_LOG_REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["proxy-authorization"]',
  "req.headers.cookie",
  // "set-cookie" is normally a response header; keep the request-side
  // path as defensive coverage in case a proxy forwards it inbound.
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  // Credential- and session-paired headers with no debugging value.
  'req.headers["x-csrf-token"]',
  'req.headers["x-xsrf-token"]',
  'req.headers["x-api-key"]',
  // Fork/adapter token headers read by this server.
  'req.headers["x-openclaw-token"]',
  'req.headers["x-openclaw-auth"]',
  'req.headers["x-paperclip-signature"]',
] as const;
