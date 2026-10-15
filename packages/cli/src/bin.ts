import { run } from './cli.ts';
import { nodeVersionError, nodeVersionHint } from './node-version.ts';

const unsupportedNode = nodeVersionError(process.version);
if (unsupportedNode !== undefined) {
  process.stderr.write(`error [unsupported-node]: ${unsupportedNode}\nhint: ${nodeVersionHint()}\n`);
  process.exitCode = 1;
} else {
  const abort = new AbortController();
  // A waiting `request` command closes its server and then exits by itself.
  // A second signal exits at once.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (abort.signal.aborted) process.exit(1);
      abort.abort();
    });
  }

  process.exitCode = await run(process.argv.slice(2), {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    signal: abort.signal,
    env: process.env,
  });
}
