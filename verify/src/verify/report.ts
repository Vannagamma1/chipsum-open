// Verification report generation

import type { VerificationInput, VerificationResult } from './types.js'

/**
 * Generate verification report as string
 */
export function generateVerificationReport(result: VerificationResult): string {
  const lines: string[] = []

  lines.push('='.repeat(60))
  lines.push('SESSION VERIFICATION REPORT')
  lines.push('='.repeat(60))
  lines.push('')

  // Overall result
  lines.push(`Overall Result: ${result.valid ? '✓ VALID' : '✗ INVALID'}`)
  lines.push('')

  // Commitment verification
  lines.push('Commitment Verification:')
  lines.push(`  House commitment: ${result.houseCommitmentValid ? '✓' : '✗'}`)
  lines.push(`  Player commitment: ${result.playerCommitmentValid ? '✓' : '✗'}`)
  lines.push(`  Seed combination: ${result.seedCombinationValid ? '✓' : '✗'}`)
  lines.push('')

  // Replay summary
  lines.push('Replay Summary:')
  lines.push(`  Ticks processed: ${result.ticksProcessed}`)
  lines.push(`  Actions executed: ${result.actionsExecuted}`)
  lines.push('')

  // Final state
  lines.push('Final State:')
  lines.push(`  Capital: $${result.replayedState.capital.toFixed(2)}`)
  lines.push(`  Current price: $${result.replayedState.currentPrice.toFixed(2)}`)
  lines.push(`  Total profit: $${result.replayedState.totalProfit.toFixed(2)}`)
  lines.push(`  Total losses: $${result.replayedState.totalLosses.toFixed(2)}`)
  lines.push(`  Turbo points: ${result.replayedState.turboPoints.toFixed(2)}`)
  lines.push('')

  // State comparison (if available)
  if (result.stateMatch !== undefined) {
    lines.push('State Comparison:')
    lines.push(`  Match: ${result.stateMatch ? '✓' : '✗'}`)
    if (result.stateDifferences && result.stateDifferences.length > 0) {
      lines.push('  Differences:')
      for (const diff of result.stateDifferences) {
        lines.push(`    - ${diff}`)
      }
    }
    lines.push('')
  }

  // Errors
  if (result.errors.length > 0) {
    lines.push('Errors:')
    for (const error of result.errors) {
      lines.push(`  ✗ ${error}`)
    }
    lines.push('')
  }

  // Warnings
  if (result.warnings.length > 0) {
    lines.push('Warnings:')
    for (const warning of result.warnings) {
      lines.push(`  ⚠ ${warning}`)
    }
    lines.push('')
  }

  lines.push('='.repeat(60))

  return lines.join('\n')
}

/**
 * Export verification data to JSON
 */
export function exportVerificationData(
  input: VerificationInput,
  result: VerificationResult
): string {
  return JSON.stringify({
    input: {
      houseSeed: input.houseSeed,
      houseCommitHash: input.houseCommitHash,
      playerSeed: input.playerSeed,
      playerCommitHash: input.playerCommitHash,
      combinedSeed: input.combinedSeed,
      config: input.config,
      actionCount: input.actionLog.length,
    },
    result: {
      valid: result.valid,
      errors: result.errors,
      warnings: result.warnings,
      commitments: {
        house: result.houseCommitmentValid,
        player: result.playerCommitmentValid,
        combined: result.seedCombinationValid,
      },
      replay: {
        ticksProcessed: result.ticksProcessed,
        actionsExecuted: result.actionsExecuted,
      },
      finalState: result.replayedState,
      stateMatch: result.stateMatch,
    },
    timestamp: Date.now(),
  }, null, 2)
}
