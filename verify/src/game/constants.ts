// Game constants - All rates consolidated from multiple source files
// These must match the server exactly for replay determinism

// ============================================
// SPREAD
// ============================================

/** Spread rate: 0.50% of notional on entry */
export const SPREAD_RATE = 0.005

// ============================================
// FUNDING
// ============================================

/** Hourly funding rate: 10% of notional */
export const FUNDING_RATE_PER_HOUR = 0.10

/** Ticks per hour at 100ms tick rate */
export const TICKS_PER_HOUR = 36000

/** Funding cost per tick */
export const FUNDING_RATE_PER_TICK = FUNDING_RATE_PER_HOUR / TICKS_PER_HOUR

/** Ticks per second */
export const TICKS_PER_SECOND = 10

// ============================================
// TURBO COSTS
// ============================================

/** Simple turbo cost rate (1% of position notional) */
export const SIMPLE_TURBO_COST_RATE = 0.01

/** Shield v2: flat rate per buy (0.66% of notional buys 10 ticks = 1 second of shield) */
export const SHIELD_FLAT_RATE = 0.0066

/** Shield ticks per purchase (10 ticks = 1 second) */
export const SHIELD_TICKS_PER_BUY = 10

/** Additional 2% of losses earns turbo points */
export const TURBO_LOSS_PREMIUM = 0.02

// ============================================
// HOUSE EDGE
// ============================================

export interface HouseEdgeConfig {
  spreadRate: number
  fundingRatePerHour: number
  optionEdgeRate: number
}

export const DEFAULT_HOUSE_EDGE: HouseEdgeConfig = {
  spreadRate: 0.005,
  fundingRatePerHour: 0.10,
  optionEdgeRate: 0.02,
}

export interface TurboPointsConfig {
  edgeEarnRate: number
  lossEarnRate: number
  shieldCostRatePerTick: number
  accelerateCostRate: number
  accelerateMinCostRate: number
  turboBetCostRate: number
}

export const DEFAULT_TURBO_POINTS: TurboPointsConfig = {
  edgeEarnRate: 0.20,
  lossEarnRate: 0.02,
  shieldCostRatePerTick: 0.0005,
  accelerateCostRate: 0.005,
  accelerateMinCostRate: 0.001,
  turboBetCostRate: 0.01,
}
