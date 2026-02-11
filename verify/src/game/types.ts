// Game types for verification
// Adapted from server types - only includes what's needed for replay

import type { LayeredEngineState } from '../engine/priceEngine.js'
import type { OptionDirection, OptionMultiplier, OptionDuration } from '../engine/optionPricing.js'

// Re-export option types for convenience
export type { OptionDirection, OptionMultiplier, OptionDuration }

// ============================================
// POSITION TYPES
// ============================================

// Position state
export interface Position {
  direction: 'long' | 'short'
  entryPrice: number
  size: number
  leverage: number
  cumulativeFunding: number
  capitalAllocated: number
  totalCapitalInvested: number
  accumulatedPnL: number       // P&L locked in from previous relever segments
  originalEntryPrice: number   // Entry price of the very first segment
  totalFundingPaid: number     // Lifetime funding across all segments
  openTick: number             // Tick when position was opened (for arcade)
}

// Option state
export interface Option {
  direction: OptionDirection
  strikePrice: number
  purchasePrice: number
  premium: number
  multiplier: OptionMultiplier
  ticksRemaining: number
  totalTicks: number  // Original duration in ticks (for progress calculation)
}

// Simple turbo state
export interface SimpleTurbo {
  active: boolean
  ticksRemaining: number
  direction: 1 | -1
  startPrice: number
}

// ============================================
// PLAYER ACTIONS
// ============================================

export type PlayerAction =
  | { type: 'open_position'; direction: 'long' | 'short'; sizePercent: number; leverage: number }
  | { type: 'close_position' }
  | { type: 'relever'; targetLeverage: number }
  | { type: 'add_equity'; additionalPercent: number }
  | { type: 'buy_shield' }
  | { type: 'buy_option'; direction: OptionDirection; premium: number; multiplier: OptionMultiplier; durationSeconds: OptionDuration }
  | { type: 'trigger_simple_turbo' }

// ============================================
// GAME STATE
// ============================================

// Complete game state
export interface GameState {
  capital: number
  currentPrice: number
  position: Position | null
  options: Option[]
  simpleTurbo: SimpleTurbo | null
  turboPoints: number
  houseBankroll: number
  shieldTicksRemaining: number

  // Layered engine state
  layeredState: LayeredEngineState

  // Tracking
  tickCount: number
  totalProfit: number
  totalLosses: number
  totalVolumeTraded: number
  liquidationCount: number
  tradeCount: number
}

// Client-facing game state (sanitized for transmission)
export interface ClientGameState {
  capital: number
  currentPrice: number
  position: Position | null
  options: Option[]
  simpleTurbo: SimpleTurbo | null
  turboPoints: number
  shieldTicksRemaining: number
  tickCount: number
  totalProfit: number
  totalLosses: number
  houseBankroll: number
}

// ============================================
// SESSION TYPES
// ============================================

export interface SessionConfig {
  initialCapital: number
  initialPrice: number
  initialHouseBankroll: number
  tickRateMs: number
  seed?: number
}

// ============================================
// ACTION LOG
// ============================================

export interface ActionLogEntry {
  tickNumber: number
  action: PlayerAction
  timestamp: number
}
