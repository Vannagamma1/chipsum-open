// Full session verification orchestrator

import type { ClientGameState } from '../game/types.js'
import type { VerificationInput, VerificationResult } from './types.js'
import { verifyCommitments } from './commitments.js'
import { replaySession, compareStates } from './replay.js'

/**
 * Full session verification
 */
export function verifySession(input: VerificationInput): VerificationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Step 1: Verify commitments
  const commitmentResult = verifyCommitments(input)
  errors.push(...commitmentResult.errors)

  // Step 2: Replay session
  const replayResult = replaySession(input)
  errors.push(...replayResult.actionErrors.map(e => `Action error: ${e}`))

  // Add warnings for skipped actions
  if (replayResult.actionsExecuted < input.actionLog.length) {
    warnings.push(`Only ${replayResult.actionsExecuted}/${input.actionLog.length} actions executed successfully`)
  }

  // Step 3: Compare states if expected state provided
  let stateMatch: boolean | undefined
  let stateDifferences: string[] | undefined

  if (input.expectedFinalState) {
    const comparison = compareStates(replayResult.finalState, input.expectedFinalState)
    stateMatch = comparison.match
    stateDifferences = comparison.differences

    if (!stateMatch) {
      errors.push(...comparison.differences.map(d => `State mismatch: ${d}`))
    }
  }

  // Convert to client state for output
  const clientState: ClientGameState = {
    capital: replayResult.finalState.capital,
    currentPrice: replayResult.finalState.currentPrice,
    position: replayResult.finalState.position,
    options: replayResult.finalState.options,
    simpleTurbo: replayResult.finalState.simpleTurbo,
    turboPoints: replayResult.finalState.turboPoints,
    shieldTicksRemaining: replayResult.finalState.shieldTicksRemaining,
    tickCount: replayResult.finalState.tickCount,
    totalProfit: replayResult.finalState.totalProfit,
    totalLosses: replayResult.finalState.totalLosses,
    houseBankroll: replayResult.finalState.houseBankroll,
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    houseCommitmentValid: commitmentResult.houseValid,
    playerCommitmentValid: commitmentResult.playerValid,
    seedCombinationValid: commitmentResult.combinedValid,
    replayedState: clientState,
    ticksProcessed: replayResult.ticksProcessed,
    actionsExecuted: replayResult.actionsExecuted,
    stateMatch,
    stateDifferences,
  }
}
