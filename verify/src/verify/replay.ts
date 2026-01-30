// Session replay engine

import { GameEngine } from '../game/gameEngine.js'
import type { GameState, ClientGameState } from '../game/types.js'
import type { VerificationInput } from './types.js'

/**
 * Replay a session deterministically
 */
export function replaySession(input: VerificationInput): {
  finalState: GameState
  ticksProcessed: number
  actionsExecuted: number
  actionErrors: string[]
} {
  // Determine the seed to use
  const seed = input.combinedSeed ?? input.houseSeed

  // Create a fresh engine with the same seed
  const engine = new GameEngine({
    ...input.config,
    seed,
  })

  // Sort actions by tick number
  const sortedActions = [...input.actionLog].sort((a, b) => {
    if (a.tickNumber !== b.tickNumber) {
      return a.tickNumber - b.tickNumber
    }
    return a.timestamp - b.timestamp
  })

  let actionIndex = 0
  let ticksProcessed = 0
  let actionsExecuted = 0
  const actionErrors: string[] = []

  // Determine how many ticks to process
  // Use expectedFinalState.tickCount if available for exact replay,
  // otherwise use heuristic based on last action
  const expectedTickCount = input.expectedFinalState?.tickCount
  const maxTick = expectedTickCount
    ?? (sortedActions.length > 0
      ? Math.max(...sortedActions.map(a => a.tickNumber)) + 100
      : 1000)

  // Process ticks
  while (ticksProcessed < maxTick) {
    // Execute any actions for this tick
    while (actionIndex < sortedActions.length &&
           sortedActions[actionIndex].tickNumber === ticksProcessed) {
      const action = sortedActions[actionIndex].action
      const stateBefore = engine.getState()
      engine.executeAction(action)
      const stateAfter = engine.getState()

      // Check if the action had any effect (state changed)
      // Note: The engine silently ignores invalid actions by returning unchanged state
      const stateChanged = JSON.stringify(stateBefore) !== JSON.stringify(stateAfter)
      if (stateChanged) {
        actionsExecuted++
      } else {
        // Action was rejected (no state change)
        actionErrors.push(`Tick ${ticksProcessed}: Action ${action.type} had no effect (possibly invalid)`)
      }

      actionIndex++
    }

    // Process tick
    engine.processTick()
    ticksProcessed++

    // If using heuristic (no expectedTickCount), stop after enough ticks past last action
    if (expectedTickCount === undefined &&
        actionIndex >= sortedActions.length &&
        ticksProcessed > (sortedActions[sortedActions.length - 1]?.tickNumber ?? 0) + 10) {
      break
    }
  }

  return {
    finalState: engine.getState(),
    ticksProcessed,
    actionsExecuted,
    actionErrors,
  }
}

/**
 * Compare two states for equivalence
 */
export function compareStates(
  actual: GameState | ClientGameState,
  expected: { capital: number; tickCount?: number; totalProfit?: number; totalLosses?: number }
): { match: boolean; differences: string[] } {
  const differences: string[] = []
  const tolerance = 0.0001  // Floating point tolerance

  // Compare capital
  if (Math.abs(actual.capital - expected.capital) > tolerance) {
    differences.push(`Capital: expected ${expected.capital}, got ${actual.capital}`)
  }

  // Compare tick count if provided
  if (expected.tickCount !== undefined && actual.tickCount !== expected.tickCount) {
    differences.push(`Tick count: expected ${expected.tickCount}, got ${actual.tickCount}`)
  }

  // Compare total profit if provided
  if (expected.totalProfit !== undefined &&
      Math.abs(actual.totalProfit - expected.totalProfit) > tolerance) {
    differences.push(`Total profit: expected ${expected.totalProfit}, got ${actual.totalProfit}`)
  }

  // Compare total losses if provided
  if (expected.totalLosses !== undefined &&
      Math.abs(actual.totalLosses - expected.totalLosses) > tolerance) {
    differences.push(`Total losses: expected ${expected.totalLosses}, got ${actual.totalLosses}`)
  }

  return {
    match: differences.length === 0,
    differences,
  }
}
