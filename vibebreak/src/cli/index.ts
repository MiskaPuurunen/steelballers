#!/usr/bin/env node
import { main } from './main.js';

// Piping into `head` etc. closes stdout early; exit quietly instead of crashing.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

const argv = process.argv.slice(2);
main(argv).then(
  (code) => {
    process.exitCode = code;
    // The hook path must never linger (it may have a half-read stdin).
    if (argv[0] === 'hook') process.exit(code);
  },
  (e: unknown) => {
    process.stderr.write(`vibebreak: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
