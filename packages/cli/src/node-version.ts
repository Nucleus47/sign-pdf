const MIN_NODE_MAJOR = 22;

/** Return a short diagnostic instead of allowing an unsupported runtime to fail later. */
export function nodeVersionError(version: string): string | undefined {
  const major = /^v?(\d+)\./.exec(version)?.[1];
  if (major !== undefined && Number(major) >= MIN_NODE_MAJOR) return undefined;
  return `sign-pdf requires Node.js ${MIN_NODE_MAJOR} or later; found ${version}.`;
}

export function nodeVersionHint(): string {
  return `Install Node.js ${MIN_NODE_MAJOR} or later, then run this command again.`;
}
