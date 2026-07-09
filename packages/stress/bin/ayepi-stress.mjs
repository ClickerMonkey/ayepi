#!/usr/bin/env node
import { run } from '../dist/cli.js';

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
