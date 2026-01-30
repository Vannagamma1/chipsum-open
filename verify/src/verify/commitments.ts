// Commitment verification

import {
  verifySeedCommitment,
  combineSeeds,
} from '../crypto/seeds.js'

import type { VerificationInput } from './types.js'

/**
 * Verify seed commitments
 */
export function verifyCommitments(input: VerificationInput): {
  houseValid: boolean
  playerValid: boolean
  combinedValid: boolean
  errors: string[]
} {
  const errors: string[] = []

  // Verify house commitment
  const houseValid = verifySeedCommitment(input.houseSeed, input.houseCommitHash)
  if (!houseValid) {
    errors.push(`House seed ${input.houseSeed} does not match commitment ${input.houseCommitHash}`)
  }

  // Verify player commitment (if provided)
  let playerValid = true
  if (input.playerSeed !== undefined && input.playerCommitHash) {
    playerValid = verifySeedCommitment(input.playerSeed, input.playerCommitHash)
    if (!playerValid) {
      errors.push(`Player seed ${input.playerSeed} does not match commitment ${input.playerCommitHash}`)
    }
  }

  // Verify combined seed calculation
  let combinedValid = true
  if (input.playerSeed !== undefined && input.combinedSeed !== undefined) {
    const expectedCombined = combineSeeds(input.houseSeed, input.playerSeed)
    combinedValid = expectedCombined === input.combinedSeed
    if (!combinedValid) {
      errors.push(`Combined seed ${input.combinedSeed} does not match expected ${expectedCombined}`)
    }
  }

  return {
    houseValid,
    playerValid,
    combinedValid,
    errors,
  }
}
