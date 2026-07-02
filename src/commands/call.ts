/**
 * `geoly call <tool> [--<param> value ...]` — the single execution entry point.
 *
 * Everything after the tool name is captured raw (clipanion Proxy) and parsed
 * here, because parameter flags are defined by the server's tool schema, not
 * by the CLI. Reserved flags (--data/--input/--org/…) are extracted first;
 * the rest map 1:1 onto schema parameter names (verbatim, underscores kept)
 * with schema-driven type coercion.
 */
import * as fs from 'node:fs';
import { Command, Option } from 'clipanion';
import { Ctx, CtxInput, makeCtx } from '../context.js';
import { GeolyError, asGeolyError } from '../errors.js';
import { McpClient, ToolInfo, unwrapToolResult } from '../mcp.js';
import { printResult, reportError, warn } from '../output.js';
import { maybeNotifyUpdate } from '../updatecheck.js';

/** Flags owned by the CLI inside `call` — a tool param with one of these names must use --data. */
const RESERVED = new Set([
  'data', 'input', 'org', 'profile', 'output', 'error-format', 'quiet', 'q',
  'refresh', 'timeout', 'no-auto-auth', 'help', 'h',
]);

interface ParsedCall {
  reserved: Map<string, string | boolean>;
  /** Raw param tokens as [name, rawValue|true] — coerced later against the schema. */
  params: Array<[string, string | true]>;
}

export class CallCommand extends Command {
  static paths = [['call']];
  static usage = Command.Usage({
    description: 'Call a GEOly tool. Parameter flags use the schema names verbatim.',
    examples: [
      ['Headline KPIs', 'geoly call get_brand_overview --time_range 30d'],
      ['Whole argument object', `geoly call get_prompt_list --data '{"page":1,"page_size":20}'`],
      ['From stdin', `echo '{"time_range":"30d"}' | geoly call get_brand_overview --input -`],
    ],
  });

  tool = Option.String();
  rest = Option.Proxy();

  async execute(): Promise<number> {
    let parsed: ParsedCall;
    let ctx: Ctx;
    try {
      parsed = parseCallArgs(this.rest);
      ctx = makeCtx(ctxInputFrom(parsed.reserved));
    } catch (err) {
      return reportError(fallbackCtx(), asGeolyError(err));
    }
    try {
      if (parsed.reserved.get('help') === true || parsed.reserved.get('h') === true) {
        return await this.printToolHelp(ctx);
      }
      const client = new McpClient(ctx);
      const tools = await client.listTools(parsed.reserved.get('refresh') === true);
      const tool = tools.find((t) => t.name === this.tool);
      if (!tool) {
        const { suggest } = await import('./tools.js');
        throw new GeolyError('usage_error', `Unknown tool "${this.tool}"`, {
          hint: suggest(this.tool, tools.map((t) => t.name)),
        });
      }
      const args = buildArguments(parsed, tool);
      const result = await client.callTool(tool.name, args);
      const value = unwrapToolResult(tool.name, result);
      emitTruncationHints(value);
      printResult(ctx, value);
      await maybeNotifyUpdate();
      return 0;
    } catch (err) {
      return reportError(ctx, asGeolyError(err));
    }
  }

  /** `geoly call <tool> --help` → schema-derived flag help. */
  private async printToolHelp(ctx: Ctx): Promise<number> {
    const tools = await new McpClient(ctx).listTools();
    const tool = tools.find((t) => t.name === this.tool);
    if (!tool) throw new GeolyError('usage_error', `Unknown tool "${this.tool}"`);
    const props = (tool.inputSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((tool.inputSchema?.required as string[] | undefined) ?? []);
    const lines = [
      `${tool.name} — ${(tool.description ?? '').split('\n')[0]}`,
      '',
      'Parameters:',
      ...Object.entries(props).map(([name, schema]) => {
        const type = String(schema.type ?? (schema.enum ? 'enum' : 'any'));
        const req = required.has(name) ? ' (required)' : '';
        const enumHint = Array.isArray(schema.enum) ? ` one of: ${(schema.enum as unknown[]).join('|')}` : '';
        return `  --${name} <${type}>${req}${enumHint}`;
      }),
      '',
      'Also: --data <json>, --input -, and the global flags (see geoly --help).',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }
}

// ---- Parsing --------------------------------------------------------------

/** Split raw proxied args into reserved CLI flags and tool parameter tokens. */
export function parseCallArgs(rest: string[]): ParsedCall {
  const reserved = new Map<string, string | boolean>();
  const params: Array<[string, string | true]> = [];
  const boolReserved = new Set(['quiet', 'q', 'refresh', 'no-auto-auth', 'help', 'h']);

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith('-')) {
      throw new GeolyError('usage_error', `Unexpected positional argument "${token}"`, {
        hint: 'Tool parameters are passed as flags: --<param> <value>.',
      });
    }
    let name = token.replace(/^--?/, '');
    let inlineValue: string | undefined;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const isReserved = RESERVED.has(name);
    if (isReserved && boolReserved.has(name)) {
      reserved.set(name, true);
      continue;
    }
    let value: string | true;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      const next = rest[i + 1];
      // A flag with no following value (or followed by another flag) is boolean-presence.
      if (next === undefined || (next.startsWith('--') && next.length > 2)) value = true;
      else {
        value = next;
        i += 1;
      }
    }
    if (isReserved) {
      if (value === true) throw new GeolyError('usage_error', `--${name} requires a value`);
      reserved.set(name, value);
    } else {
      params.push([name, value]);
    }
  }
  return { reserved, params };
}

function ctxInputFrom(reserved: Map<string, string | boolean>): CtxInput {
  const str = (k: string): string | undefined => {
    const v = reserved.get(k);
    return typeof v === 'string' ? v : undefined;
  };
  return {
    profile: str('profile'),
    org: str('org'),
    output: str('output'),
    errorFormat: str('error-format'),
    quiet: reserved.get('quiet') === true || reserved.get('q') === true,
    timeout: str('timeout'),
    noAutoAuth: reserved.get('no-auto-auth') === true,
  };
}

/** Merge --data/--input base object with individual flags (flags win), coercing via schema. */
export function buildArguments(parsed: ParsedCall, tool: ToolInfo): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  const dataRaw = parsed.reserved.get('data');
  const inputRaw = parsed.reserved.get('input');
  if (typeof dataRaw === 'string' && typeof inputRaw === 'string') {
    throw new GeolyError('usage_error', 'Use either --data or --input, not both');
  }
  const rawJson =
    typeof dataRaw === 'string'
      ? dataRaw
      : typeof inputRaw === 'string'
        ? inputRaw === '-'
          ? fs.readFileSync(0, 'utf8')
          : fs.readFileSync(inputRaw, 'utf8')
        : undefined;
  if (rawJson !== undefined) {
    try {
      const parsedJson = JSON.parse(rawJson);
      if (parsedJson === null || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
        throw new Error('must be a JSON object');
      }
      base = parsedJson as Record<string, unknown>;
    } catch (err) {
      throw new GeolyError('usage_error', `Could not parse the argument JSON: ${(err as Error).message}`);
    }
  }

  const props = (tool.inputSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, raw] of parsed.params) {
    base[name] = coerce(name, raw, props[name]);
  }
  return base;
}

/** Coerce a raw CLI token to the schema-declared type. */
function coerce(name: string, raw: string | true, schema: Record<string, unknown> | undefined): unknown {
  const type = schema?.type as string | string[] | undefined;
  const types = Array.isArray(type) ? type : type ? [type] : [];

  if (raw === true) {
    // Presence-based boolean; only valid when the schema allows boolean (or is unknown).
    if (types.length === 0 || types.includes('boolean')) return true;
    throw new GeolyError('usage_error', `--${name} requires a value (${types.join('|')})`);
  }
  if (types.includes('boolean')) {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new GeolyError('usage_error', `--${name} must be true or false`);
  }
  if (types.includes('number') || types.includes('integer')) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new GeolyError('usage_error', `--${name} must be a number, got "${raw}"`);
    return n;
  }
  if (types.includes('array') || types.includes('object')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new GeolyError('usage_error', `--${name} expects JSON (${types.join('|')}), got "${raw}"`);
    }
  }
  if (types.includes('string') || types.length === 0) {
    // Unknown schema: pass strings through untouched (predictability beats magic).
    return raw;
  }
  return raw;
}

/** Surface server truncation/pagination signals on stderr (contract §6). */
function emitTruncationHints(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (v._truncated) {
    warn('geoly: result was truncated by the server — narrow the date range or paginate');
  } else if (v.hasMore === true) {
    warn('geoly: more rows available — increase offset/limit or request the next page');
  } else if (typeof v.totalPages === 'number' && typeof v.currentPage === 'number' && v.currentPage < v.totalPages) {
    warn(`geoly: page ${v.currentPage}/${v.totalPages} — request the next page for more`);
  }
}

function fallbackCtx(): Ctx {
  return {
    endpoint: '',
    profile: 'default',
    output: 'json',
    errorFormat: 'human',
    quiet: false,
    timeoutMs: 30_000,
    noAutoAuth: true,
    noBrowser: true,
  };
}
