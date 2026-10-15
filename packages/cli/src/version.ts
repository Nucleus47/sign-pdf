import packageJson from '../package.json' with { type: 'json' };

/** The workspace package manifest is the one source of the CLI version. */
export const CLI_VERSION: string = packageJson.version;
