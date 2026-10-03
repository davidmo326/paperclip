/**
 * Jev (TypeSafe AI) client: POST { state, model, questions }, get back typed answers.
 *
 * CANONICAL COPY, shared byte-for-byte across David's repos:
 *   Hometrics   services/jevClient.ts
 *   tax-manager src/services/jevClient.ts
 *   ControlPlane docs/jev/jevClient.ts (pacc adopts this copy)
 * Edit it in one place, then copy it to the others. Projects own only their questions,
 * criteria and state builders. Transport, config and parsing live here.
 *
 * Config (read at call time, server-side only):
 *   JEV_API_KEY  required
 *   JEV_MODEL    default 'jev-latest' (resolved to 'jev-1.13.0' on 2026-10-03)
 *   JEV_API_URL  default https://api.typesafe.ai/v1/systemone
 *
 * Response shape, verified live on 2026-10-03 against api.typesafe.ai:
 *   { model: 'jev-1.13.0',
 *     answers: { <key>: { type: 'choice', choice, confidence, probabilities: { <option>: p } }
 *              | { type: 'score', score: <index>, confidence, legend: { '0': level, ... }, probabilities: { '0': p, ... } }
 *              | { type: 'noul', noul: p } },
 *     usage: { input_tokens, output_tokens } }   // no cost field
 * A response without a well-formed answer for every question asked throws: no silent empties.
 */

export const JEV_DEFAULT_API_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 15000;

// ---------- questions ----------

/** Pick one option. `criteria` maps option -> description (up to 255 options). */
export type JevChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
};

/** Place on an ordered scale. `criteria` lists 2-10 levels, lowest first; the answer's `score` is the index. */
export type JevScoreQuestion = {
  type: 'score';
  instructions: string;
  criteria: string[];
};

/** Yes/no judgment: the answer's `noul` is the probability (0-1) that `instructions` holds. */
export type JevNoulQuestion = {
  type: 'noul';
  instructions: string;
};

export type JevAnyQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

/** Kept for source compatibility (Hometrics jevShadow): a choice question. Use JevAnyQuestion for mixed maps. */
export type JevQuestion = JevChoiceQuestion;

// ---------- answers ----------

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevScoreAnswer {
  type: 'score';
  /** Index into the question's criteria (0 = first/lowest level). */
  score: number;
  /** Index (as string) -> level text, echoing the question's criteria. */
  legend: Record<string, string>;
  /** Index (as string) -> probability. */
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

export type JevAnswerFor<Q> = Q extends JevChoiceQuestion
  ? JevChoiceAnswer
  : Q extends JevScoreQuestion
    ? JevScoreAnswer
    : Q extends JevNoulQuestion
      ? JevNoulAnswer
      : JevAnswer;

export type JevAnswersFor<Q extends Record<string, JevAnyQuestion>> = { [K in keyof Q]: JevAnswerFor<Q[K]> };

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
  /** The API reports no cost; set only if a caller computes one. */
  costUsd?: number;
  /** Round-trip time measured by this client. */
  elapsedMs: number;
}

export interface JevResponse<A extends Record<string, JevAnswer> = Record<string, JevChoiceAnswer>> {
  answers: A;
  /** Model id the API resolved to, e.g. 'jev-1.13.0' for 'jev-latest'. */
  model?: string;
  usage?: JevUsage;
}

// ---------- config ----------

export interface JevConfig {
  apiKey: string | undefined;
  apiUrl: string;
  model: string;
}

const envValue = (name: string): string | undefined => {
  const value = typeof process !== 'undefined' ? process.env[name]?.trim() : undefined;
  return value ? value : undefined;
};

export const resolveJevConfig = (): JevConfig => ({
  apiKey: envValue('JEV_API_KEY'),
  apiUrl: envValue('JEV_API_URL') ?? JEV_DEFAULT_API_URL,
  model: envValue('JEV_MODEL') ?? JEV_DEFAULT_MODEL
});

export const isJevConfigured = (): boolean => Boolean(resolveJevConfig().apiKey);

// ---------- parsing ----------

export class JevError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'JevError';
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNumberMap = (value: unknown): value is Record<string, number> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'number');

const isStringMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');

const parseAnswer = (key: string, raw: unknown): JevAnswer => {
  const fail = (why: string): never => {
    throw new JevError(`Jev answer "${key}" is malformed: ${why}`);
  };
  if (!isRecord(raw)) return fail('not an object');
  switch (raw.type) {
    case 'choice':
      if (typeof raw.choice !== 'string') fail('choice is not a string');
      if (typeof raw.confidence !== 'number') fail('confidence is not a number');
      if (!isNumberMap(raw.probabilities)) fail('probabilities is not a number map');
      return {
        type: 'choice',
        choice: raw.choice as string,
        confidence: raw.confidence as number,
        probabilities: raw.probabilities as Record<string, number>
      };
    case 'score':
      if (typeof raw.score !== 'number') fail('score is not a number');
      if (typeof raw.confidence !== 'number') fail('confidence is not a number');
      if (!isStringMap(raw.legend)) fail('legend is not a string map');
      if (!isNumberMap(raw.probabilities)) fail('probabilities is not a number map');
      return {
        type: 'score',
        score: raw.score as number,
        confidence: raw.confidence as number,
        legend: raw.legend as Record<string, string>,
        probabilities: raw.probabilities as Record<string, number>
      };
    case 'noul':
      if (typeof raw.noul !== 'number') fail('noul is not a number');
      return { type: 'noul', noul: raw.noul as number };
    default:
      return fail(`unknown type ${JSON.stringify(raw.type)}`);
  }
};

/**
 * Parses a Jev response body. Throws JevError unless `answers` is an object holding a
 * well-formed answer, of the asked type, for every question in `questions`.
 */
export const parseJevResponse = <Q extends Record<string, JevAnyQuestion>>(
  body: unknown,
  questions: Q,
  elapsedMs = 0
): JevResponse<JevAnswersFor<Q>> => {
  if (!isRecord(body) || !isRecord(body.answers)) {
    const keys = isRecord(body) ? Object.keys(body).join(', ') : typeof body;
    throw new JevError(`Jev response has no answers object (got: ${keys || 'empty'})`);
  }
  const rawAnswers = body.answers;
  const answers: Record<string, JevAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    if (!(key in rawAnswers)) throw new JevError(`Jev response is missing answer "${key}"`);
    const answer = parseAnswer(key, rawAnswers[key]);
    if (answer.type !== question.type) {
      throw new JevError(`Jev answer "${key}" has type ${answer.type}, asked ${question.type}`);
    }
    answers[key] = answer;
  }

  let usage: JevUsage | undefined;
  if (isRecord(body.usage)) {
    usage = {
      inputTokens: typeof body.usage.input_tokens === 'number' ? body.usage.input_tokens : 0,
      outputTokens: typeof body.usage.output_tokens === 'number' ? body.usage.output_tokens : 0,
      elapsedMs
    };
  }

  return {
    answers: answers as JevAnswersFor<Q>,
    model: typeof body.model === 'string' ? body.model : undefined,
    usage
  };
};

// ---------- transport ----------

export interface JevCallOptions {
  timeoutMs?: number;
  /** Extra attempts after a 429, 5xx, timeout or network error (default 0). */
  retries?: number;
  /** Overrides JEV_MODEL for this call. */
  model?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One Jev call. Throws JevError on missing config, HTTP errors, timeouts and malformed
 * responses; callers that want graceful fallback catch it and log.
 * The third argument may be a timeout in ms (legacy Hometrics signature) or options.
 */
export async function callJev<Q extends Record<string, JevAnyQuestion>>(
  state: unknown,
  questions: Q,
  opts: number | JevCallOptions = {}
): Promise<JevResponse<JevAnswersFor<Q>>> {
  const options: JevCallOptions = typeof opts === 'number' ? { timeoutMs: opts } : opts;
  const config = resolveJevConfig();
  if (!config.apiKey) throw new JevError('JEV_API_KEY is not configured.');

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = 1 + Math.max(0, options.retries ?? 0);
  const payload = JSON.stringify({ state, model: options.model ?? config.model, questions });

  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let retryable = false;
    try {
      const response = await fetch(config.apiUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: payload
      });
      if (!response.ok) {
        retryable = response.status === 429 || response.status >= 500;
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        throw new JevError(`Jev request failed (${response.status}): ${detail}`, response.status);
      }
      const body: unknown = await response.json().catch(() => {
        throw new JevError('Jev response is not JSON');
      });
      return parseJevResponse(body, questions, Date.now() - startedAt);
    } catch (error) {
      if (!(error instanceof JevError)) {
        retryable = true;
        const reason = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : (error as Error).message;
        error = new JevError(`Jev request failed: ${reason}`);
      }
      if (!retryable || attempt >= attempts) throw error;
      await sleep(1000 * attempt);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
