// Seed Cryptography - Verification-only subset
// For provably fair commit-reveal verification

import { createHash } from 'crypto'

// ============================================
// COMMITMENT HASHING
// ============================================

/**
 * Hash a seed value using SHA-256
 * This creates the commitment that can be revealed later
 */
export function hashSeed(seed: number): string {
  return createHash('sha256')
    .update(seed.toString())
    .digest('hex')
}

/**
 * Hash arbitrary data
 */
export function sha256(data: string | Buffer): string {
  return createHash('sha256')
    .update(data)
    .digest('hex')
}

/**
 * Verify a seed matches its commitment hash
 */
export function verifySeedCommitment(seed: number, commitHash: string): boolean {
  const computedHash = hashSeed(seed)
  return computedHash === commitHash
}

// ============================================
// SEED COMBINATION
// ============================================

/**
 * Combine two seeds using XOR
 * This is the standard way to combine entropy from multiple sources
 */
export function combineSeeds(seed1: number, seed2: number): number {
  return (seed1 ^ seed2) >>> 0  // Ensure unsigned 32-bit
}

/**
 * Combine multiple seeds
 */
export function combineSeedsMultiple(...seeds: number[]): number {
  return seeds.reduce((acc, seed) => combineSeeds(acc, seed), 0)
}
