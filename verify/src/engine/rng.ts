// ============================================
// SEEDED PRNG (Mulberry32)
// ============================================

/**
 * Fast, seedable 32-bit PRNG using Mulberry32 algorithm.
 * Deterministic: same seed always produces same sequence.
 */
export class SeededRNG {
  private state: number

  constructor(seed: number) {
    // Ensure we have a valid integer seed
    this.state = seed >>> 0
    if (this.state === 0) this.state = 1
  }

  /**
   * Returns a number in [0, 1)
   */
  next(): number {
    // Mulberry32
    let t = (this.state += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /**
   * Returns a number in [min, max)
   */
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  /**
   * Returns true with given probability
   */
  chance(probability: number): boolean {
    return this.next() < probability
  }
}

/**
 * Simple hash function to derive sub-seeds from a master seed + label
 */
export function hashSeed(seed: number, label: string): number {
  let hash = seed
  for (let i = 0; i < label.length; i++) {
    hash = ((hash << 5) - hash + label.charCodeAt(i)) | 0
  }
  return hash >>> 0
}
