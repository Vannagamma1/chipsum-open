// ============================================
// OPTION PRICING SYSTEM
// ============================================
// Empirically calibrated strike distances for targeted house edge
// with LAYERED price engine (independent entropy layers, EV-neutral with drift correction).
//
// For a multiplier M with target edge E:
// - Win probability P = (1-E)/M
// - Strike distances found via Monte Carlo simulation (100k-500k samples)
//
// Recalibrated Feb 2026 via recalibrateFinal.ts with 2-tick execution delay for 1s/5s options.
// 1s/5s: calibrated to target approximately 1% estimated house edge (with 2-tick/200ms server-side execution delay)
// 30s/60s/300s: calibrated to target approximately 2% estimated house edge (no execution delay)
//
// All edges are estimates from Monte Carlo simulation of tested strategies, not mathematical
// guarantees. Untested strategies may experience different effective edges.
//
// Includes momentum and reversion for exciting price dynamics, with drift correction.

export type OptionDirection = 'call' | 'put'
export type OptionMultiplier = 2 | 5 | 10 | 25 | 100
export type OptionDuration = 1 | 5 | 30 | 60 | 300  // seconds

// Empirically calibrated strike distances (as percentages)
// Recalibrated Feb 2026 — see comment block above for methodology
const STRIKE_DISTANCES: Record<OptionDuration, Partial<Record<OptionMultiplier, number>>> = {
  1:   { 2: 0.900, 5: 1.625, 10: 2.017, 25: 2.429, 100: 2.950 },
  5:   { 2: 1.594, 5: 3.890, 10: 5.108, 25: 6.490, 100: 8.287 },
  30:  { 2: 1.753, 5: 8.320, 10: 11.559, 25: 15.233, 100: 19.310 },
  60:  { 2: 2.202, 5: 10.754, 10: 15.552, 25: 20.416, 100: 26.460 },
  300: { 2: 2.930, 5: 22.305, 10: 31.479, 25: 42.280, 100: 63.792 },
}

// Straddle strike distances (tighter than naked — momentum partially cancels when buying both legs)
// Same delay/edge config as naked: 1s/5s = 2-tick delay + ~1% edge, 30s+ = no delay + ~2% edge
const STRADDLE_STRIKE_DISTANCES: Record<OptionDuration, Partial<Record<OptionMultiplier, number>>> = {
  1:   { 2: 0.016, 5: 1.138, 10: 1.627, 25: 2.134, 100: 2.691 },
  5:   { 2: 0.040, 5: 2.742, 10: 4.112, 25: 5.537, 100: 7.431 },
  30:  { 2: 0.185, 5: 6.663, 10: 10.007, 25: 13.715, 100: 17.986 },
  60:  { 2: 0.280, 5: 9.137, 10: 13.850, 25: 19.112, 100: 25.203 },
  300: { 2: 0.784, 5: 20.989, 10: 30.378, 25: 40.565, 100: 57.014 },
}

/**
 * Check if an option multiplier is available for a given duration.
 * Layered engine supports up to 100x multiplier.
 */
export function isOptionMultiplierAvailable(
  multiplier: OptionMultiplier,
  durationSeconds: OptionDuration
): boolean {
  return STRIKE_DISTANCES[durationSeconds]?.[multiplier] !== undefined
}

/**
 * Get the maximum available multiplier for a given duration.
 */
export function getMaxMultiplierForDuration(durationSeconds: OptionDuration): OptionMultiplier {
  return 100  // Layered engine supports up to 100x
}

/**
 * Calculate the strike price for an option given the parameters.
 * Returns the absolute strike price.
 */
export function calculateOptionStrike(
  currentPrice: number,
  direction: OptionDirection,
  multiplier: OptionMultiplier,
  durationSeconds: OptionDuration,
  isStraddle: boolean = false
): number {
  const table = isStraddle ? STRADDLE_STRIKE_DISTANCES : STRIKE_DISTANCES
  const strikePercent = table[durationSeconds]?.[multiplier]

  // If multiplier not available for this duration, return current price (warning)
  if (strikePercent === undefined) {
    console.warn(`Option multiplier ${multiplier}x not available for ${durationSeconds}s duration`)
    return currentPrice
  }

  const strikeDistance = strikePercent / 100

  if (direction === 'call') {
    // Call wins if price goes UP to strike
    return currentPrice * (1 + strikeDistance)
  } else {
    // Put wins if price goes DOWN to strike
    return currentPrice * (1 - strikeDistance)
  }
}

/**
 * Calculate the strike distance as a percentage for display purposes.
 */
export function calculateStrikeDistancePercent(
  multiplier: OptionMultiplier,
  durationSeconds: OptionDuration,
  isStraddle: boolean = false
): number {
  const table = isStraddle ? STRADDLE_STRIKE_DISTANCES : STRIKE_DISTANCES
  return table[durationSeconds]?.[multiplier] ?? 1.0
}

/**
 * Get the full option pricing grid for display.
 * Returns strike distances as percentages for each combination.
 */
export function getOptionPricingGrid(): Record<OptionDuration, Record<OptionMultiplier, number>> {
  const durations: OptionDuration[] = [1, 5, 30, 60, 300]
  const multipliers: OptionMultiplier[] = [2, 5, 10, 25, 100]

  const grid = {} as Record<OptionDuration, Record<OptionMultiplier, number>>

  for (const duration of durations) {
    grid[duration] = {} as Record<OptionMultiplier, number>
    for (const multiplier of multipliers) {
      grid[duration][multiplier] = calculateStrikeDistancePercent(multiplier, duration)
    }
  }

  return grid
}

/**
 * Get the straddle option pricing grid for display.
 * Returns tighter strike distances for straddle positions.
 */
export function getStraddlePricingGrid(): Record<OptionDuration, Record<OptionMultiplier, number>> {
  const durations: OptionDuration[] = [1, 5, 30, 60, 300]
  const multipliers: OptionMultiplier[] = [2, 5, 10, 25, 100]

  const grid = {} as Record<OptionDuration, Record<OptionMultiplier, number>>

  for (const duration of durations) {
    grid[duration] = {} as Record<OptionMultiplier, number>
    for (const multiplier of multipliers) {
      grid[duration][multiplier] = calculateStrikeDistancePercent(multiplier, duration, true)
    }
  }

  return grid
}

/**
 * Check if an option is in the money at expiration.
 */
export function isOptionInTheMoney(
  direction: OptionDirection,
  strikePrice: number,
  currentPrice: number
): boolean {
  if (direction === 'call') {
    return currentPrice >= strikePrice
  } else {
    return currentPrice <= strikePrice
  }
}

/**
 * Calculate option payout at expiration.
 * Returns 0 if out of the money, or premium x multiplier if in the money.
 */
export function calculateOptionPayout(
  direction: OptionDirection,
  strikePrice: number,
  currentPrice: number,
  premium: number,
  multiplier: OptionMultiplier
): number {
  if (isOptionInTheMoney(direction, strikePrice, currentPrice)) {
    return premium * multiplier
  }
  return 0
}
