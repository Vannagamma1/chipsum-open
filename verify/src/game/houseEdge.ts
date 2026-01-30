// House Edge Configuration - Centralized edge rates for all products
// These rates determine how much edge the house takes on each product type

import {
  DEFAULT_HOUSE_EDGE,
  DEFAULT_TURBO_POINTS,
  type HouseEdgeConfig,
  type TurboPointsConfig,
} from './constants.js'

// Re-export types and defaults
export { DEFAULT_HOUSE_EDGE, DEFAULT_TURBO_POINTS }
export type { HouseEdgeConfig, TurboPointsConfig }

/**
 * Calculate edge paid on opening a position
 * Edge = spread cost (notional x spreadRate)
 */
export function calculatePositionEntryEdge(
  notional: number,
  config: HouseEdgeConfig = DEFAULT_HOUSE_EDGE
): number {
  return notional * config.spreadRate
}

/**
 * Calculate edge paid from funding over time
 * Edge = notional x fundingRate x hours
 */
export function calculateFundingEdge(
  notional: number,
  holdTimeMs: number,
  config: HouseEdgeConfig = DEFAULT_HOUSE_EDGE
): number {
  const hours = holdTimeMs / (1000 * 60 * 60)
  return notional * config.fundingRatePerHour * hours
}

/**
 * Calculate edge paid per tick from funding
 * Edge = notional x (fundingRatePerHour / ticksPerHour)
 */
export function calculateFundingEdgePerTick(
  notional: number,
  tickRateMs: number = 100,
  config: HouseEdgeConfig = DEFAULT_HOUSE_EDGE
): number {
  const ticksPerHour = (1000 * 60 * 60) / tickRateMs
  return notional * (config.fundingRatePerHour / ticksPerHour)
}

/**
 * Calculate edge paid on an option purchase
 * Edge = premium x optionEdgeRate
 */
export function calculateOptionEdge(
  premium: number,
  config: HouseEdgeConfig = DEFAULT_HOUSE_EDGE
): number {
  return premium * config.optionEdgeRate
}

/**
 * Calculate turbo points earned from edge paid
 */
export function calculateEdgePoints(
  edgePaid: number,
  config: TurboPointsConfig = DEFAULT_TURBO_POINTS
): number {
  return edgePaid * config.edgeEarnRate
}

/**
 * Calculate turbo points earned from losses
 */
export function calculateLossPoints(
  lossAmount: number,
  config: TurboPointsConfig = DEFAULT_TURBO_POINTS
): number {
  return Math.abs(lossAmount) * config.lossEarnRate
}

/**
 * Calculate total turbo points earned
 */
export function calculateTotalPointsEarned(
  edgePaid: number,
  lossAmount: number,
  config: TurboPointsConfig = DEFAULT_TURBO_POINTS
): number {
  return calculateEdgePoints(edgePaid, config) + calculateLossPoints(lossAmount, config)
}

/**
 * Summary of edge paid for a complete position lifecycle
 */
export interface PositionEdgeSummary {
  spreadEdge: number
  fundingEdge: number
  totalEdge: number
}

/**
 * Calculate total edge paid for a position from open to close
 */
export function calculatePositionTotalEdge(
  notional: number,
  holdTimeMs: number,
  config: HouseEdgeConfig = DEFAULT_HOUSE_EDGE
): PositionEdgeSummary {
  const spreadEdge = calculatePositionEntryEdge(notional, config)
  const fundingEdge = calculateFundingEdge(notional, holdTimeMs, config)
  return {
    spreadEdge,
    fundingEdge,
    totalEdge: spreadEdge + fundingEdge,
  }
}
