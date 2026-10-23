#!/usr/bin/env bun
import { commands } from './commands/index.ts'
import { runCli } from './run.ts'

const out = await runCli(process.argv.slice(2), commands)
if (out.stdout) process.stdout.write(out.stdout)
if (out.stderr) process.stderr.write(out.stderr)
process.exit(out.exitCode)
