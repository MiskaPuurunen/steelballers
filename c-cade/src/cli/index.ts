#!/usr/bin/env node

// Piping into `head` etc. closes stdout early; exit quietly instead of crashing.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

const argv = process.argv.slice(2);
// The hook hot path skips loading the arcade entirely.
const isHook = argv[0] === 'hook' && (argv.length === 1 || argv[1].startsWith('-'));
const run = isHook
  ? import('./hook.js').then((m) => m.hookMain(argv))
  : import('./main.js').then((m) => m.main(argv));
run.then(
  (code) => {
    process.exitCode = code;
    // The hook path must never linger (it may have a half-read stdin).
    if (argv[0] === 'hook') process.exit(code);
  },
  (e: unknown) => {
    process.stderr.write(`c-cade: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
