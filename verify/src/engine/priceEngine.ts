/**
 * Layered Coefficient Price Engine
 *
 * Designed for provably fair, exploitation-resistant price generation.
 * Each coefficient layer uses independent entropy, so even if one layer
 * is predictable, the composite price movement is not.
 *
 * Layers:
 *   1. Sign (direction): +1 or -1
 *   2. Magnitude (base size): how much the price moves
 *   3. Volatility (multiplier): calm periods vs spikes
 *   4. Momentum (trend bias): continuation tendency
 *   5. Reversion (mean pull): derived from deviation, not random
 */

import { SeededRNG, hashSeed } from './rng.js'

// ============================================
// LAYER CONFIGURATION
// ============================================

export interface LayerConfig {
  // Sign layer
  signBias: number              // 0.5 = fair, >0.5 = bullish bias

  // Magnitude layer
  baseMagnitudeMin: number      // Minimum move size (e.g., 0.0005)
  baseMagnitudeMax: number      // Maximum move size (e.g., 0.003)

  // Volatility layer
  volatilityBase: number        // Normal multiplier (e.g., 1.0)
  volatilitySpikeProbability: number  // Chance of spike per tick
  volatilitySpikeMin: number    // Min spike multiplier (e.g., 2.0)
  volatilitySpikeMax: number    // Max spike multiplier (e.g., 5.0)

  // Momentum layer
  momentumStrength: number      // How much momentum affects next move (e.g., 0.2)
  momentumDecay: number         // How fast momentum fades (e.g., 0.95)

  // Reversion layer
  reversionStrength: number     // Pull toward mean (e.g., 0.05)
  reversionHalfLife: number     // Ticks for mean to move halfway to price

  // Drift correction (to offset momentum-induced positive drift)
  driftCorrection: number       // Per-tick correction (e.g., -0.000008 for -0.0008%/tick)
}

export const DEFAULT_LAYER_CONFIG: LayerConfig = {
  // Sign: perfectly fair
  signBias: 0.5,

  // Magnitude: 0.05% to 0.25% per tick base
  baseMagnitudeMin: 0.0005,
  baseMagnitudeMax: 0.0025,

  // Volatility: occasional 2-4x spikes
  volatilityBase: 1.0,
  volatilitySpikeProbability: 0.02,  // 2% chance per tick
  volatilitySpikeMin: 2.0,
  volatilitySpikeMax: 4.0,

  // Momentum: mild trend continuation
  momentumStrength: 0.15,
  momentumDecay: 0.92,

  // Reversion: slow drift toward moving average
  reversionStrength: 0.03,
  reversionHalfLife: 500,  // ~50 seconds at 10 ticks/sec

  // Drift correction: cancels momentum-induced positive drift
  // Calibrated empirically: -0.000008 per tick ≈ -2.4% over 3000 ticks
  driftCorrection: -0.000008,
}

// ============================================
// LAYERED PRICE ENGINE
// ============================================

export interface LayeredEngineState {
  price: number
  tick: number
  meanPrice: number
  momentum: number
  lastSign: number
  inVolatilitySpike: boolean
  // Turbo state (new simplified system)
  turboActive: boolean
  turboTicksRemaining: number
  turboDirection: 1 | -1  // Pre-determined from seed
}

export interface LayeredTickResult {
  newPrice: number
  newState: LayeredEngineState
  // Debug info for each layer (only exposed in test mode)
  debug?: {
    sign: number
    baseMagnitude: number
    volatilityMultiplier: number
    momentumContribution: number
    reversionContribution: number
    driftCorrection: number
    totalDelta: number
  }
}

export class LayeredPriceEngine {
  private signRng: SeededRNG
  private magnitudeRng: SeededRNG
  private volatilityRng: SeededRNG
  private momentumRng: SeededRNG
  private turboRng: SeededRNG  // Independent seed for turbo direction

  private config: LayerConfig

  constructor(
    masterSeed: number,
    config: LayerConfig = DEFAULT_LAYER_CONFIG
  ) {
    // Derive independent seeds for each layer
    this.signRng = new SeededRNG(hashSeed(masterSeed, 'sign'))
    this.magnitudeRng = new SeededRNG(hashSeed(masterSeed, 'magnitude'))
    this.volatilityRng = new SeededRNG(hashSeed(masterSeed, 'volatility'))
    this.momentumRng = new SeededRNG(hashSeed(masterSeed, 'momentum'))
    this.turboRng = new SeededRNG(hashSeed(masterSeed, 'turbo'))

    this.config = config
  }

  /**
   * Create initial state
   */
  createInitialState(startPrice: number = 100): LayeredEngineState {
    return {
      price: startPrice,
      tick: 0,
      meanPrice: startPrice,
      momentum: 0,
      lastSign: 0,
      inVolatilitySpike: false,
      // Turbo (new simplified system)
      turboActive: false,
      turboTicksRemaining: 0,
      turboDirection: 1,
    }
  }

  /**
   * Get next turbo direction from the seed (called when player triggers turbo)
   * This consumes one value from the turbo RNG stream
   */
  getNextTurboDirection(): 1 | -1 {
    return this.turboRng.next() < 0.5 ? 1 : -1
  }

  /**
   * Generate next tick using layered coefficients
   */
  nextTick(state: LayeredEngineState, includeDebug: boolean = false): LayeredTickResult {
    const { config } = this

    // ========== TURBO OVERRIDE ==========
    // During turbo, price movement is deterministic: 10% move over 10 ticks
    if (state.turboActive && state.turboTicksRemaining > 0) {
      // Calculate per-tick move for 10% total over 10 ticks
      // Using geometric compounding: (1 + r)^10 = 1.10 for up, 0.90 for down
      // r = 1.10^(1/10) - 1 ≈ 0.00957 per tick for up
      // r = 0.90^(1/10) - 1 ≈ -0.01046 per tick for down
      const targetMultiplier = state.turboDirection === 1 ? 1.10 : 0.90
      const perTickMultiplier = Math.pow(targetMultiplier, 1 / 10)

      const newPrice = state.price * perTickMultiplier
      const newTicksRemaining = state.turboTicksRemaining - 1

      const newState: LayeredEngineState = {
        ...state,
        price: newPrice,
        tick: state.tick + 1,
        turboTicksRemaining: newTicksRemaining,
        turboActive: newTicksRemaining > 0,
      }

      return {
        newPrice,
        newState,
        ...(includeDebug && {
          debug: {
            sign: state.turboDirection,
            baseMagnitude: perTickMultiplier - 1,
            volatilityMultiplier: 1,
            momentumContribution: 0,
            reversionContribution: 0,
            driftCorrection: 0,
            totalDelta: perTickMultiplier - 1,
          }
        })
      }
    }

    // ========== Normal price generation (layered coefficients) ==========

    // ========== Layer 1: Sign (Independent, fair 50/50) ==========
    const signRoll = this.signRng.next()
    const sign = signRoll < config.signBias ? 1 : -1

    // ========== Layer 2: Magnitude (Independent) ==========
    const baseMagnitude = this.magnitudeRng.range(
      config.baseMagnitudeMin,
      config.baseMagnitudeMax
    )

    // ========== Layer 3: Volatility (Independent) ==========
    let volatilityMultiplier = config.volatilityBase
    let inSpike = state.inVolatilitySpike

    if (!inSpike && this.volatilityRng.chance(config.volatilitySpikeProbability)) {
      inSpike = true
    }

    if (inSpike) {
      volatilityMultiplier = this.volatilityRng.range(
        config.volatilitySpikeMin,
        config.volatilitySpikeMax
      )
      // Spikes last 1 tick in this simple model (could extend)
      inSpike = false
    }

    // ========== Layer 4: Momentum (creates trending behavior) ==========
    // Momentum accumulates based on recent direction, creating trend continuation
    const momentumNoise = (this.momentumRng.next() - 0.5) * 0.1
    const newMomentum = state.momentum * config.momentumDecay + state.lastSign * config.momentumStrength + momentumNoise
    const momentumContribution = newMomentum * baseMagnitude

    // ========== Layer 5: Reversion (pulls price toward moving average) ==========
    const deviation = (state.price - state.meanPrice) / state.meanPrice
    const reversionContribution = -deviation * config.reversionStrength * baseMagnitude

    // ========== Layer 6: Drift Correction ==========
    // Momentum creates positive drift in multiplicative returns (up-trends compound better)
    // This correction cancels that drift to maintain EV neutrality
    const driftCorrectionAmount = config.driftCorrection

    // ========== Combine Layers ==========
    const signedMove = sign * baseMagnitude * volatilityMultiplier
    const totalDelta = signedMove + momentumContribution + reversionContribution + driftCorrectionAmount

    const newPrice = Math.max(0.01, state.price * (1 + totalDelta))

    // Update mean price (slow moving average)
    const meanAlpha = 1 / config.reversionHalfLife
    const newMeanPrice = state.meanPrice * (1 - meanAlpha) + newPrice * meanAlpha

    const newState: LayeredEngineState = {
      price: newPrice,
      tick: state.tick + 1,
      meanPrice: newMeanPrice,
      momentum: newMomentum,
      lastSign: sign,
      inVolatilitySpike: inSpike,
      // Preserve turbo state (inactive)
      turboActive: state.turboActive,
      turboTicksRemaining: state.turboTicksRemaining,
      turboDirection: state.turboDirection,
    }

    const result: LayeredTickResult = {
      newPrice,
      newState,
    }

    if (includeDebug) {
      result.debug = {
        sign,
        baseMagnitude,
        volatilityMultiplier,
        momentumContribution,
        reversionContribution,
        driftCorrection: driftCorrectionAmount,
        totalDelta,
      }
    }

    return result
  }

  /**
   * Start a turbo event on the given state
   * Returns a new state with turbo active
   */
  startTurbo(state: LayeredEngineState): LayeredEngineState {
    const direction = this.getNextTurboDirection()
    return {
      ...state,
      turboActive: true,
      turboTicksRemaining: 10, // 10 ticks = 1 second at 100ms/tick
      turboDirection: direction,
    }
  }

  /**
   * Generate a full price series (for pre-commitment)
   */
  generateSeries(ticks: number, startPrice: number = 100): number[] {
    const prices: number[] = [startPrice]
    let state = this.createInitialState(startPrice)

    for (let t = 0; t < ticks; t++) {
      const result = this.nextTick(state)
      prices.push(result.newPrice)
      state = result.newState
    }

    return prices
  }
}
