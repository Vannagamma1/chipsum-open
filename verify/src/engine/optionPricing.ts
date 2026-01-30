// ============================================
// OPTION PRICING SYSTEM
// ============================================
// Empirically calibrated strike distances for ~2% house edge
// with LAYERED price engine (independent entropy layers, EV-neutral with drift correction).
//
// For a multiplier M with 2% house edge:
// - Win probability P = 0.98/M
// - Strike distances found via Monte Carlo simulation (100k-500k samples)
//
// Includes momentum and reversion for exciting price dynamics, with drift correction.

export type OptionDirection = 'call' | 'put'
export type OptionMultiplier = 2 | 5 | 10 | 25 | 100
export type OptionDuration = 1 | 5 | 30 | 60 | 300  // seconds

// Empirically calibrated strike distances (as percentages)
// Calibrated for 2% house edge with layered engine (Jan 2026)
const STRIKE_DISTANCES: Record<OptionDuration, Partial<Record<OptionMultiplier, number>>> = {
  1:   { 2: 0.020, 5: 0.694, 10: 1.052, 25: 1.422, 100: 1.880 },
  5:   { 2: 0.059, 5: 2.338, 10: 3.535, 25: 4.791, 100: 6.351 },
  30:  { 2: 0.213, 5: 6.446, 10: 9.705, 25: 13.243, 100: 17.644 },
  60:  { 2: 0.253, 5: 9.191, 10: 13.828, 25: 18.823, 100: 25.346 },
  300: { 2: 0.587, 5: 20.263, 10: 30.162, 25: 41.016, 100: 59.495 },
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
  durationSeconds: OptionDuration
): number {
  const strikePercent = STRIKE_DISTANCES[durationSeconds]?.[multiplier]

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
  durationSeconds: OptionDuration
): number {
  return STRIKE_DISTANCES[durationSeconds]?.[multiplier] ?? 1.0
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
