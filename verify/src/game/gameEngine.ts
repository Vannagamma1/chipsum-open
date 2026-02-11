// Game Engine - Server-authoritative game logic
// Adapted from server for standalone verification

import {
  GameState,
  Position,
  Option,
  SimpleTurbo,
  PlayerAction,
  SessionConfig,
} from './types.js'

import {
  LayeredPriceEngine,
  DEFAULT_LAYER_CONFIG,
  LayeredEngineState,
} from '../engine/priceEngine.js'

import {
  calculateOptionStrike,
  isOptionInTheMoney,
} from '../engine/optionPricing.js'

import { calculateLeveragedPnL, isPositionLiquidated } from './positionMath.js'
import { calculateEdgePoints, calculateOptionEdge } from './houseEdge.js'
import {
  SPREAD_RATE,
  FUNDING_RATE_PER_HOUR,
  FUNDING_RATE_PER_TICK,
  TICKS_PER_SECOND,
  SIMPLE_TURBO_COST_RATE,
  SHIELD_FLAT_RATE,
  SHIELD_TICKS_PER_BUY,
  TURBO_LOSS_PREMIUM,
} from './constants.js'

/**
 * Game Engine instance for a single session
 * Encapsulates all game state and logic
 */
export class GameEngine {
  private priceEngine: LayeredPriceEngine
  private state: GameState
  private config: SessionConfig

  constructor(config: SessionConfig) {
    this.config = config
    const seed = config.seed ?? Math.floor(Math.random() * 0xFFFFFFFF)
    this.priceEngine = new LayeredPriceEngine(seed, DEFAULT_LAYER_CONFIG)

    const layeredState = this.priceEngine.createInitialState(config.initialPrice)

    this.state = {
      capital: config.initialCapital,
      currentPrice: config.initialPrice,
      position: null,
      options: [],
      simpleTurbo: null,
      turboPoints: 0,
      houseBankroll: config.initialHouseBankroll,
      shieldTicksRemaining: 0,
      layeredState,
      tickCount: 0,
      totalProfit: 0,
      totalLosses: 0,
      totalVolumeTraded: 0,
      liquidationCount: 0,
      tradeCount: 0,
    }
  }

  /**
   * Get current game state (read-only copy)
   */
  getState(): GameState {
    return { ...this.state }
  }

  /**
   * Get current price
   */
  getCurrentPrice(): number {
    return this.state.currentPrice
  }

  /**
   * Get tick count
   */
  getTickCount(): number {
    return this.state.tickCount
  }

  /**
   * Process a single tick
   * Returns the new state
   */
  processTick(): GameState {
    let newState = { ...this.state }
    newState.tickCount++

    // === PRICE GENERATION (Layered Engine) ===
    const result = this.priceEngine.nextTick(this.state.layeredState)
    const newPrice = result.newPrice
    let layeredState = result.newState

    // Check if simple turbo just ended
    let simpleTurboEnded = false
    if (this.state.simpleTurbo?.active && !layeredState.turboActive) {
      simpleTurboEnded = true
    }

    // Update simple turbo state (sync with layered engine state)
    let updatedSimpleTurbo: SimpleTurbo | null = this.state.simpleTurbo
    if (layeredState.turboActive) {
      updatedSimpleTurbo = {
        active: true,
        ticksRemaining: layeredState.turboTicksRemaining,
        direction: layeredState.turboDirection,
        startPrice: this.state.simpleTurbo?.startPrice ?? this.state.currentPrice,
      }
    } else if (simpleTurboEnded) {
      updatedSimpleTurbo = null
    }

    // === SHIELD HANDLING (v2: tick-based, burns only when equity <= 0) ===
    let shieldTicksRemaining = this.state.shieldTicksRemaining
    let newTurboPoints = this.state.turboPoints

    // Reset shield if no position
    if (!this.state.position && shieldTicksRemaining > 0) {
      shieldTicksRemaining = 0
    }

    const shieldActive = shieldTicksRemaining > 0

    // === POSITION MANAGEMENT ===
    let updatedPosition = this.state.position ? { ...this.state.position } : null
    let newLosses = 0
    let newHouseBankroll = this.state.houseBankroll

    if (updatedPosition) {
      const funding = updatedPosition.cumulativeFunding

      // Check liquidation
      if (updatedPosition) {
        if (isPositionLiquidated(
          updatedPosition.entryPrice,
          newPrice,
          updatedPosition.direction,
          updatedPosition.size,
          updatedPosition.leverage,
          funding
        )) {
          if (shieldTicksRemaining > 0) {
            // Shield active: burn a tick instead of liquidating
            shieldTicksRemaining--
          } else {
            // No shield: liquidate
            const totalCapitalInvested = updatedPosition.totalCapitalInvested
            // At liquidation: equity = size + pricePnL - funding = 0
            // House gets: -pricePnL + funding = size (the player's margin)
            newHouseBankroll += updatedPosition.size
            newLosses += totalCapitalInvested
            newState.liquidationCount++
            updatedPosition = null
          }
        }
      }

      // Accrue funding if position still exists (tracked on position, realized to house on close)
      if (updatedPosition) {
        const positionNotional = updatedPosition.size * updatedPosition.leverage
        const fundingCost = positionNotional * FUNDING_RATE_PER_TICK
        // Note: funding is NOT added to houseBankroll here - it's added when position closes
        updatedPosition.cumulativeFunding += fundingCost
        updatedPosition.totalFundingPaid += fundingCost
        // Earn turbo points from funding edge (funding cost IS the edge - house takes 100%)
        newTurboPoints += calculateEdgePoints(fundingCost)
      }
    }

    // === OPTIONS MANAGEMENT ===
    let optionsReturn = 0
    let optionsNetProfit = 0
    const updatedOptions: Option[] = []

    for (const option of this.state.options) {
      const newTicks = option.ticksRemaining - 1

      if (newTicks <= 0) {
        const inTheMoney = isOptionInTheMoney(option.direction, option.strikePrice, newPrice)
        const payout = inTheMoney ? option.premium * option.multiplier : 0
        const profit = payout - option.premium

        if (inTheMoney) {
          optionsReturn += payout
          optionsNetProfit += profit
          newHouseBankroll -= profit
        } else {
          optionsNetProfit -= option.premium
          newHouseBankroll += option.premium
          newLosses += option.premium
        }
      } else {
        updatedOptions.push({ ...option, ticksRemaining: newTicks })
      }
    }

    // === FINAL CALCULATIONS ===
    const finalTurboPoints = newTurboPoints + (newLosses * TURBO_LOSS_PREMIUM)
    let finalCapital = this.state.capital + optionsReturn
    let finalTotalProfit = this.state.totalProfit + optionsNetProfit

    // Update state
    newState.currentPrice = newPrice
    newState.position = updatedPosition
    newState.options = updatedOptions
    newState.simpleTurbo = updatedSimpleTurbo
    newState.turboPoints = finalTurboPoints
    newState.capital = Math.max(0, finalCapital)
    newState.houseBankroll = newHouseBankroll
    newState.totalProfit = finalTotalProfit
    newState.totalLosses = this.state.totalLosses + newLosses
    newState.shieldTicksRemaining = shieldTicksRemaining
    newState.layeredState = layeredState

    this.state = newState
    return newState
  }

  /**
   * Execute a player action
   * Returns the updated state
   */
  executeAction(action: PlayerAction): GameState {
    const newState = { ...this.state }

    switch (action.type) {
      case 'open_position': {
        if (this.state.position) return this.state  // Already have position

        const requestedBudget = Math.min(this.state.capital * action.sizePercent, this.state.capital)
        if (requestedBudget <= 0) return this.state

        const spreadMultiplier = 1 + action.leverage * SPREAD_RATE
        const size = requestedBudget / spreadMultiplier
        const notional = size * action.leverage
        const spreadCost = notional * SPREAD_RATE
        const edgePoints = calculateEdgePoints(spreadCost)
        const totalCost = size + spreadCost

        newState.capital = this.state.capital - totalCost
        newState.turboPoints = this.state.turboPoints + edgePoints
        newState.houseBankroll = this.state.houseBankroll + spreadCost
        newState.totalVolumeTraded = this.state.totalVolumeTraded + notional
        newState.tradeCount = this.state.tradeCount + 1
        newState.position = {
          direction: action.direction,
          entryPrice: this.state.currentPrice,
          size,
          leverage: action.leverage,
          cumulativeFunding: 0,
          capitalAllocated: totalCost,
          totalCapitalInvested: totalCost,
          accumulatedPnL: 0,
          originalEntryPrice: this.state.currentPrice,
          totalFundingPaid: 0,
          openTick: this.state.tickCount,
        }
        break
      }

      case 'close_position': {
        if (!this.state.position) return this.state

        const pricePnL = calculateLeveragedPnL(
          this.state.position.entryPrice,
          this.state.currentPrice,
          this.state.position.direction,
          this.state.position.size,
          this.state.position.leverage
        )
        const funding = this.state.position.cumulativeFunding
        let houseBankroll = this.state.houseBankroll

        // House gets funding (realized on close) and loses/gains on price P&L
        houseBankroll += funding
        houseBankroll -= pricePnL

        const returnedCapital = this.state.position.size + pricePnL - funding
        const truePnL = Math.max(0, returnedCapital) - this.state.position.totalCapitalInvested
        const newLosses = truePnL < 0 ? Math.abs(truePnL) : 0
        const lossBonus = newLosses * TURBO_LOSS_PREMIUM

        newState.capital = this.state.capital + Math.max(0, returnedCapital)
        newState.totalProfit = this.state.totalProfit + (pricePnL - funding)
        newState.position = null
        newState.houseBankroll = houseBankroll
        newState.totalLosses = this.state.totalLosses + newLosses
        newState.turboPoints = this.state.turboPoints + lossBonus
        newState.shieldTicksRemaining = 0
        break
      }

      case 'buy_shield': {
        if (!this.state.position) return this.state
        const notional = this.state.position.size * this.state.position.leverage
        const cost = notional * SHIELD_FLAT_RATE
        if (this.state.turboPoints < cost) return this.state
        newState.turboPoints = this.state.turboPoints - cost
        newState.shieldTicksRemaining = this.state.shieldTicksRemaining + SHIELD_TICKS_PER_BUY
        break
      }

      case 'buy_option': {
        if (action.premium <= 0 || action.premium > this.state.capital) return this.state

        const strikePrice = calculateOptionStrike(
          this.state.currentPrice,
          action.direction,
          action.multiplier,
          action.durationSeconds
        )

        const optionEdge = calculateOptionEdge(action.premium)
        const edgePoints = calculateEdgePoints(optionEdge)

        newState.capital = this.state.capital - action.premium
        newState.turboPoints = this.state.turboPoints + edgePoints
        newState.totalVolumeTraded = this.state.totalVolumeTraded + action.premium
        const totalTicks = action.durationSeconds * TICKS_PER_SECOND
        newState.options = [...this.state.options, {
          direction: action.direction,
          strikePrice,
          purchasePrice: this.state.currentPrice,
          premium: action.premium,
          multiplier: action.multiplier,
          ticksRemaining: totalTicks,
          totalTicks,
        }]
        break
      }

      case 'trigger_simple_turbo': {
        if (!this.state.position || this.state.simpleTurbo?.active) return this.state

        const notional = this.state.position.size * this.state.position.leverage
        const cost = notional * SIMPLE_TURBO_COST_RATE

        if (this.state.turboPoints < cost) return this.state

        // Trigger turbo on the layered engine
        const newLayeredState = this.priceEngine.startTurbo(this.state.layeredState)

        newState.turboPoints = this.state.turboPoints - cost
        newState.layeredState = newLayeredState
        newState.simpleTurbo = {
          active: true,
          ticksRemaining: 10,
          direction: newLayeredState.turboDirection,
          startPrice: this.state.currentPrice,
        }
        break
      }

      case 'relever': {
        if (!this.state.position || action.targetLeverage < 1) return this.state

        const pricePnL = calculateLeveragedPnL(
          this.state.position.entryPrice,
          this.state.currentPrice,
          this.state.position.direction,
          this.state.position.size,
          this.state.position.leverage
        )
        const funding = this.state.position.cumulativeFunding
        const equity = this.state.position.size + pricePnL - funding

        if (equity <= 0) return this.state

        const newNotional = equity * action.targetLeverage
        const spreadCost = newNotional * SPREAD_RATE
        const newSize = equity - spreadCost

        if (newSize <= 0) return this.state

        const edgePoints = calculateEdgePoints(spreadCost)

        const lockedInPnL = pricePnL - funding - spreadCost
        const prevAccumulatedPnL = this.state.position.accumulatedPnL

        newState.turboPoints = this.state.turboPoints + edgePoints
        newState.houseBankroll = this.state.houseBankroll + spreadCost + funding - pricePnL
        newState.totalVolumeTraded = this.state.totalVolumeTraded + newNotional
        newState.position = {
          ...this.state.position,
          entryPrice: this.state.currentPrice,
          size: newSize,
          leverage: action.targetLeverage,
          cumulativeFunding: 0,
          capitalAllocated: newSize,
          accumulatedPnL: prevAccumulatedPnL + lockedInPnL,
          totalFundingPaid: this.state.position.totalFundingPaid + funding,
        }
        break
      }

      case 'add_equity': {
        if (!this.state.position) return this.state

        const additionalCapital = this.state.capital * action.additionalPercent
        if (additionalCapital <= 0) return this.state

        const pricePnL = calculateLeveragedPnL(
          this.state.position.entryPrice,
          this.state.currentPrice,
          this.state.position.direction,
          this.state.position.size,
          this.state.position.leverage
        )
        const funding = this.state.position.cumulativeFunding
        const currentEquity = this.state.position.size + pricePnL - funding

        if (currentEquity <= 0) return this.state

        const units = (this.state.position.size * this.state.position.leverage) / this.state.position.entryPrice
        const newEquity = currentEquity + additionalCapital
        const notionalAtCurrentPrice = units * this.state.currentPrice
        const newLeverage = Math.max(1, notionalAtCurrentPrice / newEquity)

        const addEquityLockedInPnL = pricePnL - funding
        const addEquityPrevAccumulatedPnL = this.state.position.accumulatedPnL

        newState.capital = this.state.capital - additionalCapital
        newState.houseBankroll = this.state.houseBankroll + funding - pricePnL
        newState.position = {
          ...this.state.position,
          entryPrice: this.state.currentPrice,
          size: newEquity,
          leverage: newLeverage,
          cumulativeFunding: 0,
          capitalAllocated: newEquity,
          totalCapitalInvested: this.state.position.totalCapitalInvested + additionalCapital,
          accumulatedPnL: addEquityPrevAccumulatedPnL + addEquityLockedInPnL,
          totalFundingPaid: this.state.position.totalFundingPaid + funding,
        }
        break
      }
    }

    this.state = newState
    return newState
  }

  /**
   * Get the price engine (for seed verification)
   */
  getPriceEngine(): LayeredPriceEngine {
    return this.priceEngine
  }
}
