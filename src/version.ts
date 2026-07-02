/** CLI version. Kept in sync with the release manifest by the release workflow. */
export const VERSION = '0.1.0';

/** MCP protocol version this client speaks. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Default remote MCP endpoint (the single production tool surface). */
export const DEFAULT_ENDPOINT = 'https://app.geoly.ai/api/mcp';

/** Release manifest consumed by `geoly upgrade` and the daily update notice. */
export const MANIFEST_URL = 'https://geoly.ai/cli/manifest.json';
