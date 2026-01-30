// Verification data structures

import type { SessionConfig, PlayerAction, ClientGameState, ActionLogEntry } from '../game/types.js'

// Re-export for convenience
export type { ActionLogEntry }

export interface VerificationInput {
  // Seeds
  houseSeed: number
  houseCommitHash: string
  playerSeed?: number
  playerCommitHash?: string
  combinedSeed?: number

  // Session configuration
  config: SessionConfig

  // Action log
  actionLog: ActionLogEntry[]

  // Expected final state (optional, for comparison)
  expectedFinalState?: {
    capital: number
    tickCount?: number
    totalProfit?: number
    totalLosses?: number
  }
}

export interface VerificationResult {
  valid: boolean
  errors: string[]
  warnings: string[]

  // Commitment verification
  houseCommitmentValid: boolean
  playerCommitmentValid: boolean
  seedCombinationValid: boolean

  // Replay results
  replayedState: ClientGameState
  ticksProcessed: number
  actionsExecuted: number

  // State comparison (if expected state provided)
  stateMatch?: boolean
  stateDifferences?: string[]
}
