// chipsum-verify — Public API
// Provably fair session verification for Chipsum trading game

// Primary verification
export { verifySession } from './verify/verify.js'
export { verifyCommitments } from './verify/commitments.js'
export { replaySession, compareStates } from './verify/replay.js'
export { generateVerificationReport, exportVerificationData } from './verify/report.js'

// Verification types
export type { VerificationInput, VerificationResult } from './verify/types.js'

// Seed cryptography
export { hashSeed, sha256, verifySeedCommitment, combineSeeds, combineSeedsMultiple } from './crypto/seeds.js'

// Price engine (for independent reconstruction)
export { LayeredPriceEngine, DEFAULT_LAYER_CONFIG } from './engine/priceEngine.js'
export type { LayerConfig, LayeredEngineState, LayeredTickResult } from './engine/priceEngine.js'
export { SeededRNG, hashSeed as hashSeedLabel } from './engine/rng.js'

// Option pricing
export {
  calculateOptionStrike,
  isOptionInTheMoney,
  calculateOptionPayout,
  calculateStrikeDistancePercent,
  getOptionPricingGrid,
  isOptionMultiplierAvailable,
  getMaxMultiplierForDuration,
} from './engine/optionPricing.js'

// Game engine (for advanced replay)
export { GameEngine } from './game/gameEngine.js'

// Game types
export type {
  GameState,
  ClientGameState,
  Position,
  Option,
  SimpleTurbo,
  PlayerAction,
  SessionConfig,
  ActionLogEntry,
  OptionDirection,
  OptionMultiplier,
  OptionDuration,
} from './game/types.js'

// Position math
export {
  calculateLeveragedPnL,
  isPositionLiquidated,
  calculateDynamicLiquidationPrice,
  calculateEquity,
  calculateEffectiveLeverage,
  calculateBreakevenPrice,
} from './game/positionMath.js'

// House edge
export {
  calculatePositionEntryEdge,
  calculateFundingEdge,
  calculateFundingEdgePerTick,
  calculateOptionEdge,
  calculateEdgePoints,
  calculateLossPoints,
  calculateTotalPointsEarned,
  calculatePositionTotalEdge,
  DEFAULT_HOUSE_EDGE,
  DEFAULT_TURBO_POINTS,
} from './game/houseEdge.js'
export type { HouseEdgeConfig, TurboPointsConfig, PositionEdgeSummary } from './game/houseEdge.js'

// All game constants
export {
  SPREAD_RATE,
  FUNDING_RATE_PER_HOUR,
  FUNDING_RATE_PER_TICK,
  TICKS_PER_HOUR,
  TICKS_PER_SECOND,
  SIMPLE_TURBO_COST_RATE,
  SHIELD_FLAT_RATE,
  SHIELD_TICKS_PER_BUY,
  TURBO_LOSS_PREMIUM,
} from './game/constants.js'
