// Position Math - Pure functions for P&L and liquidation calculations
// These functions are used by both the game and simulation

/**
 * Calculate leveraged P&L for a directional position
 * Returns the profit/loss in dollar terms
 *
 * @param entryPrice - Price when position was opened
 * @param currentPrice - Current market price
 * @param direction - 'long' or 'short'
 * @param size - Position size (equity/collateral)
 * @param leverage - Leverage multiplier
 * @returns P&L in dollars (positive = profit, negative = loss)
 */
export function calculateLeveragedPnL(
  entryPrice: number,
  currentPrice: number,
  direction: 'long' | 'short',
  size: number,
  leverage: number
): number {
  const priceChange = (currentPrice - entryPrice) / entryPrice
  const multiplier = direction === 'long' ? 1 : -1
  return size * priceChange * multiplier * leverage
}

/**
 * Check if a position should be liquidated based on net equity
 * Equity = size + pricePnL - cumulativeFunding
 * Liquidation occurs when equity <= 0
 *
 * @param entryPrice - Price when position was opened
 * @param currentPrice - Current market price
 * @param direction - 'long' or 'short'
 * @param size - Position size (equity/collateral)
 * @param leverage - Leverage multiplier
 * @param cumulativeFunding - Total funding fees paid so far
 * @returns true if position should be liquidated
 */
export function isPositionLiquidated(
  entryPrice: number,
  currentPrice: number,
  direction: 'long' | 'short',
  size: number,
  leverage: number,
  cumulativeFunding: number
): boolean {
  const pricePnL = calculateLeveragedPnL(entryPrice, currentPrice, direction, size, leverage)
  const equity = size + pricePnL - cumulativeFunding
  return equity <= 0
}

/**
 * Calculate dynamic liquidation price that accounts for accumulated funding
 * As funding drains equity, liquidation price moves closer to current price
 *
 * Derivation:
 * Liquidation when: size + pricePnL - funding = 0
 * pricePnL = funding - size
 * For long: size * ((P - E) / E) * L = funding - size
 *   => P = E * (1 - 1/L + funding/(size*L))
 * For short: size * ((E - P) / E) * L = funding - size
 *   => P = E * (1 + 1/L - funding/(size*L))
 *
 * @param entryPrice - Price when position was opened
 * @param direction - 'long' or 'short'
 * @param size - Position size (equity/collateral)
 * @param leverage - Leverage multiplier
 * @param cumulativeFunding - Total funding fees paid so far
 * @returns The price at which liquidation would occur
 */
export function calculateDynamicLiquidationPrice(
  entryPrice: number,
  direction: 'long' | 'short',
  size: number,
  leverage: number,
  cumulativeFunding: number
): number {
  const fundingFactor = cumulativeFunding / (size * leverage)

  if (direction === 'long') {
    return entryPrice * (1 - 1/leverage + fundingFactor)
  } else {
    return entryPrice * (1 + 1/leverage - fundingFactor)
  }
}

/**
 * Calculate current equity for a position
 * Equity = size + pricePnL - cumulativeFunding
 *
 * @param entryPrice - Price when position was opened
 * @param currentPrice - Current market price
 * @param direction - 'long' or 'short'
 * @param size - Position size (equity/collateral)
 * @param leverage - Leverage multiplier
 * @param cumulativeFunding - Total funding fees paid so far
 * @returns Current equity in dollars
 */
export function calculateEquity(
  entryPrice: number,
  currentPrice: number,
  direction: 'long' | 'short',
  size: number,
  leverage: number,
  cumulativeFunding: number
): number {
  const pricePnL = calculateLeveragedPnL(entryPrice, currentPrice, direction, size, leverage)
  return size + pricePnL - cumulativeFunding
}

/**
 * Calculate effective leverage for a position
 * Effective leverage = notional / equity
 * Changes as the position moves into profit/loss
 *
 * @param entryPrice - Price when position was opened
 * @param currentPrice - Current market price
 * @param direction - 'long' or 'short'
 * @param size - Position size (equity/collateral)
 * @param leverage - Nominal leverage multiplier
 * @param cumulativeFunding - Total funding fees paid so far
 * @returns Effective leverage (0 if equity <= 0)
 */
export function calculateEffectiveLeverage(
  entryPrice: number,
  currentPrice: number,
  direction: 'long' | 'short',
  size: number,
  leverage: number,
  cumulativeFunding: number
): number {
  const equity = calculateEquity(entryPrice, currentPrice, direction, size, leverage, cumulativeFunding)
  if (equity <= 0) return 0

  // Notional = size × leverage × (currentPrice / entryPrice)
  const notional = size * leverage * (currentPrice / entryPrice)
  return notional / equity
}

/**
 * Calculate breakeven price for a position
 * The price where returnedCapital = totalCapitalInvested
 *
 * @param entryPrice - Current segment entry price
 * @param direction - 'long' or 'short'
 * @param size - Position size (equity/collateral)
 * @param leverage - Leverage multiplier
 * @param cumulativeFunding - Total funding fees paid so far
 * @param totalCapitalInvested - Total capital put into position over lifetime
 * @returns The breakeven price
 */
export function calculateBreakevenPrice(
  entryPrice: number,
  direction: 'long' | 'short',
  size: number,
  leverage: number,
  cumulativeFunding: number,
  totalCapitalInvested: number
): number {
  // At breakeven: size + pricePnL - funding = totalCapitalInvested
  // pricePnL needed = totalCapitalInvested - size + funding
  const pricePnLNeeded = totalCapitalInvested - size + cumulativeFunding
  const breakevenMove = pricePnLNeeded / (size * leverage)

  if (direction === 'long') {
    return entryPrice * (1 + breakevenMove)
  } else {
    return entryPrice * (1 - breakevenMove)
  }
}
