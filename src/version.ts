/** CLI version. Kept in sync with the release manifest by the release workflow. */
export const VERSION = '0.1.1';

/** MCP protocol version this client speaks. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Default remote MCP endpoint (the single production tool surface). */
export const DEFAULT_ENDPOINT = 'https://app.geoly.ai/api/mcp';

/**
 * Release manifest consumed by `geoly upgrade` and the daily update notice.
 * The `releases/latest/download` URL always points at the newest release's
 * asset — no domain routing dependency. geoly.ai/cli/manifest.json is a
 * Cloudflare redirect to the same place.
 */
export const MANIFEST_URL = 'https://github.com/geoly-ai/GEOly-Cli/releases/latest/download/manifest.json';
