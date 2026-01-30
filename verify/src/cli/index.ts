#!/usr/bin/env node
// CLI Tool for Session Verification
// Verifies provably fair sessions by replaying them deterministically

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { verifySession } from '../verify/verify.js'
import { generateVerificationReport, exportVerificationData } from '../verify/report.js'
import type { VerificationInput } from '../verify/types.js'

// ============================================
// CLI INTERFACE
// ============================================

interface CLIArgs {
  inputFile?: string
  outputFile?: string
  format: 'text' | 'json'
  verbose: boolean
  help: boolean
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2)
  const result: CLIArgs = {
    format: 'text',
    verbose: false,
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '-i':
      case '--input':
        result.inputFile = args[++i]
        break
      case '-o':
      case '--output':
        result.outputFile = args[++i]
        break
      case '-f':
      case '--format':
        result.format = args[++i] as 'text' | 'json'
        break
      case '-v':
      case '--verbose':
        result.verbose = true
        break
      case '-h':
      case '--help':
        result.help = true
        break
      default:
        if (!arg.startsWith('-') && !result.inputFile) {
          result.inputFile = arg
        }
    }
  }

  return result
}

function printUsage(): void {
  console.log(`
Chipsum Session Verifier
========================

Verifies that a game session was provably fair by replaying it deterministically.

Usage:
  npx chipsum-verify [options] [input-file]

Options:
  -i, --input <file>     Input JSON file with verification data
  -o, --output <file>    Output file for verification report
  -f, --format <fmt>     Output format: text or json (default: text)
  -v, --verbose          Verbose output
  -h, --help             Show this help message

Input File Format:
  {
    "houseSeed": 12345,
    "houseCommitHash": "abc123...",
    "playerSeed": 67890,
    "playerCommitHash": "def456...",
    "combinedSeed": 12345 ^ 67890,
    "config": {
      "initialCapital": 1000,
      "initialPrice": 100,
      "initialHouseBankroll": 10000000,
      "tickRateMs": 100
    },
    "actionLog": [
      { "tickNumber": 10, "action": { "type": "open_position", ... }, "timestamp": 123456789 }
    ],
    "expectedFinalState": {
      "capital": 950,
      "tickCount": 100
    }
  }

Examples:
  # Verify from a JSON file
  npx chipsum-verify session-data.json

  # Verify and save report
  npx chipsum-verify -i session.json -o report.txt

  # JSON output
  npx chipsum-verify session.json --format json
`)
}

// ============================================
// VERIFICATION LOGIC
// ============================================

function loadFromFile(filepath: string): VerificationInput {
  if (!existsSync(filepath)) {
    throw new Error(`File not found: ${filepath}`)
  }

  const content = readFileSync(filepath, 'utf-8')
  const data = JSON.parse(content) as Record<string, unknown>

  // Validate required fields
  if (typeof data.houseSeed !== 'number') {
    throw new Error('Missing or invalid houseSeed')
  }
  if (typeof data.houseCommitHash !== 'string') {
    throw new Error('Missing or invalid houseCommitHash')
  }
  const config = data.config as Record<string, unknown> | undefined
  if (!config || typeof config.initialCapital !== 'number') {
    throw new Error('Missing or invalid config')
  }
  if (!Array.isArray(data.actionLog)) {
    throw new Error('Missing or invalid actionLog')
  }

  return data as unknown as VerificationInput
}

function main(): void {
  const args = parseArgs()

  if (args.help) {
    printUsage()
    process.exit(0)
  }

  // Load verification data
  let input: VerificationInput

  try {
    if (args.inputFile) {
      input = loadFromFile(args.inputFile)
    } else {
      console.error('Error: No input specified. Use -i <file> or provide a file path.')
      printUsage()
      process.exit(1)
    }
  } catch (err) {
    console.error(`Error loading verification data: ${err}`)
    process.exit(1)
  }

  if (args.verbose) {
    console.log('\nLoaded verification data:')
    console.log(`  House seed: ${input.houseSeed}`)
    console.log(`  House commit: ${input.houseCommitHash.substring(0, 16)}...`)
    console.log(`  Player seed: ${input.playerSeed ?? 'N/A'}`)
    console.log(`  Combined seed: ${input.combinedSeed ?? input.houseSeed}`)
    console.log(`  Actions: ${input.actionLog.length}`)
    console.log('')
  }

  // Run verification
  console.log('Verifying session...\n')
  const result = verifySession(input)

  // Generate output
  let output: string
  if (args.format === 'json') {
    output = exportVerificationData(input, result)
  } else {
    output = generateVerificationReport(result)
  }

  // Write or print output
  if (args.outputFile) {
    writeFileSync(args.outputFile, output)
    console.log(`Report written to ${args.outputFile}`)
  } else {
    console.log(output)
  }

  // Exit with appropriate code
  process.exit(result.valid ? 0 : 1)
}

// Run
main()
