import packageJson from '../package.json' with { type: 'json' };

/** The workspace package manifest is the one source of the MCP version. */
export const MCP_VERSION: string = packageJson.version;
