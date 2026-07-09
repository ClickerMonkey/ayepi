/**
 * `ayepi-stress` — ramp the built-in archetypes (or your own target/URL) and print a report.
 *
 * ```
 * npx @ayepi/stress                          # benchmark the built-in noop/io/net/cpu archetypes
 * npx @ayepi/stress --target ./my-server.js  # spawn your module (it must print the ready line)
 * npx @ayepi/stress --url http://localhost:3000 --stats-url http://localhost:3000/__stats
 * npx @ayepi/stress --archetypes cpu,net --duration 5000 --max 256 --json
 * ```
 *
 * @module
 */

import { benchmarkArchetypes, stressTarget, type StressWorkload } from './index';
import { formatRamp, summarizeRamps } from './report';
import type { Archetype, RampResult } from './types';
import { ARCHETYPES } from './types';

interface Args {
  target?: string;
  url?: string;
  statsUrl?: string;
  noStats?: boolean;
  archetypes?: string;
  duration?: number;
  start?: number;
  max?: number;
  factor?: number;
  warmup?: number;
  timeout?: number;
  json?: boolean;
  nodeArgs: string[];
  help?: boolean;
}

/** Minimal flag parser (`--flag value`, `--bool`, repeatable `--node-arg`). */
function parseArgs(argv: readonly string[]): Args {
  const args: Args = { nodeArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => argv[++i] ?? '';
    switch (a) {
      case '--target': args.target = next(); break;
      case '--url': args.url = next(); break;
      case '--stats-url': args.statsUrl = next(); break;
      case '--no-stats': args.noStats = true; break;
      case '--archetypes': args.archetypes = next(); break;
      case '--duration': args.duration = Number(next()); break;
      case '--start': args.start = Number(next()); break;
      case '--max': args.max = Number(next()); break;
      case '--factor': args.factor = Number(next()); break;
      case '--warmup': args.warmup = Number(next()); break;
      case '--timeout': args.timeout = Number(next()); break;
      case '--node-arg': args.nodeArgs.push(next()); break;
      case '--json': args.json = true; break;
      case '--help': case '-h': args.help = true; break;
      default: process.stderr.write(`unknown flag: ${a}\n`);
    }
  }
  return args;
}

const HELP = `ayepi-stress — ramp ayepi endpoints to their breaking point

Usage: ayepi-stress [options]

Target (default: the built-in noop/io/net/cpu archetypes, spawned in a child process)
  --target <module>   Spawn your module as the target (it must print the @ayepi/stress:ready line)
  --url <url>         Ramp an already-running server instead of spawning one
  --stats-url <url>   Its /__stats URL (default <url>/__stats; use --no-stats to skip)
  --no-stats          Don't scrape server-side stats

Ramp
  --archetypes <csv>  Which archetypes/paths to ramp (default noop,io,net,cpu)
  --duration <ms>     Measured duration per rung (default 3000)
  --start <n>         Ladder start concurrency (default 1)
  --max <n>           Ladder ceiling (default 512)
  --factor <n>        Ladder growth factor (default 2)
  --warmup <ms>       Warmup per rung (default 250)
  --timeout <ms>      Per-request timeout (default 10000)
  --node-arg <arg>    Extra Node arg for the spawned target (repeatable), e.g. --node-arg --max-old-space-size=256

Output
  --json              Emit JSON instead of the table
  -h, --help          This help
`;

/** Turn `--archetypes` into workloads. Known names map to `/name`; anything else is treated as a raw path. */
function workloadsFrom(csv: string | undefined): StressWorkload[] | undefined {
  if (!csv) {return undefined;}
  return csv.split(',').map((s) => s.trim()).filter(Boolean).map((name) => {
    if ((ARCHETYPES as readonly string[]).includes(name)) {return name as Archetype;}
    const path = name.startsWith('/') ? name : `/${name}`;
    return { path, label: name };
  });
}

/** Run the CLI. Returns the process exit code. */
export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const ramp = {
    stepDurationMs: args.duration,
    start: args.start,
    maxConcurrency: args.max,
    factor: args.factor,
    warmupMs: args.warmup,
    timeoutMs: args.timeout,
    onStep: undefined,
  };
  const workloads = workloadsFrom(args.archetypes);
  const onRamp = (r: RampResult): void => {
    if (!args.json) {process.stdout.write(`\n${formatRamp(r)}`);}
  };

  let results: RampResult[];
  if (args.url) {
    const statsUrl = args.noStats ? undefined : args.statsUrl ?? `${args.url.replace(/\/$/, '')}/__stats`;
    results = await stressTarget({ url: args.url.replace(/\/$/, ''), statsUrl }, { workloads, ramp, onRamp });
  } else {
    const out = await benchmarkArchetypes({
      workloads,
      ramp,
      onRamp,
      spawn: { entry: args.target, nodeArgs: args.nodeArgs },
    });
    results = out.results;
  }

  if (args.json) {process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);}
  else {process.stdout.write(`\n${summarizeRamps(results)}\n`);}
  return 0;
}
