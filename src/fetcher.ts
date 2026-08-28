/**
 * Local page fetching — the agent's eyes on the open web.
 *
 * Why local rather than through the server: half of GEO work is "what does your
 * page look like to something that crawls it", and a plain HTTP client is
 * exactly that lens. Doing it here also costs nothing, adds no round trip, and
 * uses the machine that already has the network access.
 *
 * It runs on the user's machine, so it gets a real guard rail: only http(s),
 * every redirect hop re-checked, and private/loopback/link-local addresses
 * refused — the model must not be able to use the CLI to probe the user's
 * internal network.
 */
import * as dns from 'node:dns/promises';
import * as net from 'node:net';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 2_000_000;
/** Extracted text handed to the model; the file tools are the place for anything longer. */
const MAX_TEXT_CHARS = 40_000;
const MAX_REDIRECTS = 3;

/** Blocked destinations: loopback, private, link-local, CGNAT, unique-local v6. */
function isBlockedAddress(address: string): boolean {
  const type = net.isIP(address);
  if (type === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (type === 6) {
    const v6 = address.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
    // IPv4-mapped (::ffff:10.0.0.1) — check the embedded v4
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)/.exec(v6);
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
    return false;
  }
  return false;
}

/** Resolve the host and refuse anything that points inside the user's network. */
async function assertPublicHost(hostname: string): Promise<string | undefined> {
  const literal = net.isIP(hostname);
  if (literal) {
    return isBlockedAddress(hostname) ? 'address is private or loopback' : undefined;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.internal')) {
    return 'host is local';
  }
  let records: { address: string }[];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    return 'host could not be resolved';
  }
  if (records.length === 0) return 'host could not be resolved';
  if (records.some((r) => isBlockedAddress(r.address))) return 'host resolves to a private address';
  return undefined;
}

/**
 * Strip HTML down to readable text.
 *
 * Deliberately crude — no DOM parser, no dependency. Script/style/nav noise is
 * dropped, entities are decoded for the handful that actually matter, and the
 * result is whitespace-collapsed. This is what a crawler that does not run
 * JavaScript would come away with, which is the point of the exercise.
 */
function htmlToText(html: string): { title?: string; description?: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const description =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1]?.trim() ??
    /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html)?.[1]?.trim();

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // 结构性标签换成换行，保住段落/标题的边界，否则整页糊成一行
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

  return { title, description, text };
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  title?: string;
  description?: string;
  text: string;
  truncated: boolean;
}

/**
 * Fetch one page. Redirects are followed manually so every hop gets the same
 * host check — following them inside `fetch` would let a public URL bounce to
 * an internal one.
 */
export async function fetchPage(rawUrl: string): Promise<FetchedPage | { error: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: `not a valid URL: ${rawUrl.slice(0, 120)}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'only http and https URLs can be fetched' };
  }

  const started = Date.now();
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const blocked = await assertPublicHost(current.hostname);
    if (blocked) return { error: `refused ${current.hostname}: ${blocked}` };

    let res: Response;
    try {
      res = await fetch(current.toString(), {
        redirect: 'manual',
        headers: {
          // 明示身份，不伪装成浏览器：站点有权拒绝我们
          'user-agent': 'GEOly-CLI/agent (+https://www.geoly.ai)',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
        },
        signal: AbortSignal.timeout(Math.max(1000, FETCH_TIMEOUT_MS - (Date.now() - started))),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      return { error: timedOut ? 'fetch timed out' : `fetch failed: ${(err as Error).message}` };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return { error: `redirect without a location header (${res.status})` };
      try {
        current = new URL(location, current);
      } catch {
        return { error: `bad redirect target: ${location.slice(0, 120)}` };
      }
      continue;
    }

    const contentType = res.headers.get('content-type') ?? undefined;
    const buffer = await res.arrayBuffer().catch(() => undefined);
    if (!buffer) return { error: 'response body could not be read' };
    const bytes = buffer.byteLength;
    const body = new TextDecoder('utf-8').decode(buffer.slice(0, MAX_BYTES));

    const isHtml = !contentType || /html|xml/i.test(contentType);
    const parsed = isHtml ? htmlToText(body) : { text: body };
    const truncated = bytes > MAX_BYTES || parsed.text.length > MAX_TEXT_CHARS;
    return {
      url: rawUrl,
      finalUrl: current.toString(),
      status: res.status,
      contentType,
      title: 'title' in parsed ? parsed.title : undefined,
      description: 'description' in parsed ? parsed.description : undefined,
      text: parsed.text.slice(0, MAX_TEXT_CHARS),
      truncated,
    };
  }
  return { error: `too many redirects (>${MAX_REDIRECTS})` };
}

export const FETCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'fetch_page',
    description:
      'Fetch a public web page and return its readable text (plus title and meta description). ' +
      'Runs from this machine with a plain HTTP client and does NOT execute JavaScript — which is ' +
      'the point: it shows roughly what a non-rendering crawler sees. Use it to look at the ' +
      "brand's own pages, a competitor's page, or a cited source, when the question is about why " +
      'an AI answer says what it says. Private and loopback addresses are refused.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full http(s) URL.' } },
      required: ['url'],
    },
  },
};

