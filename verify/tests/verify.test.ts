import { createHash } from 'crypto'
import {
  verifySession,
  verifySeedCommitment,
  hashSeed,
  combineSeeds,
  replaySession,
  generateVerificationReport,
  GameEngine,
  SeededRNG,
  LayeredPriceEngine,
  DEFAULT_LAYER_CONFIG,
  SPREAD_RATE,
  FUNDING_RATE_PER_TICK,
} from '../src/index.js'
import type { VerificationInput } from '../src/index.js'

// Helper: compute SHA-256 hash of a seed
function sha256Hash(seed: number): string {
  return createHash('sha256').update(seed.toString()).digest('hex')
}

describe('Seed Cryptography', () => {
  test('hashSeed produces SHA-256 of seed string', () => {
    const seed = 12345
    const expected = sha256Hash(seed)
    expect(hashSeed(seed)).toBe(expected)
  })

  test('verifySeedCommitment returns true for matching seed/hash', () => {
    const seed = 42
    const hash = hashSeed(seed)
    expect(verifySeedCommitment(seed, hash)).toBe(true)
  })

  test('verifySeedCommitment returns false for mismatched seed/hash', () => {
    const seed = 42
    const wrongHash = hashSeed(99999)
    expect(verifySeedCommitment(seed, wrongHash)).toBe(false)
  })

  test('combineSeeds is XOR and unsigned', () => {
    expect(combineSeeds(0xAAAAAAAA, 0x55555555)).toBe(0xFFFFFFFF)
    expect(combineSeeds(100, 100)).toBe(0)
    expect(combineSeeds(0, 12345)).toBe(12345)
  })
})

describe('SeededRNG', () => {
  test('same seed produces same sequence', () => {
    const rng1 = new SeededRNG(42)
    const rng2 = new SeededRNG(42)
    for (let i = 0; i < 100; i++) {
      expect(rng1.next()).toBe(rng2.next())
    }
  })

  test('different seeds produce different sequences', () => {
    const rng1 = new SeededRNG(1)
    const rng2 = new SeededRNG(2)
    // At least one of the first 10 values should differ
    let allSame = true
    for (let i = 0; i < 10; i++) {
      if (rng1.next() !== rng2.next()) allSame = false
    }
    expect(allSame).toBe(false)
  })

  test('values are in [0, 1)', () => {
    const rng = new SeededRNG(999)
    for (let i = 0; i < 1000; i++) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('LayeredPriceEngine', () => {
  test('deterministic: same seed produces same price series', () => {
    const engine1 = new LayeredPriceEngine(42, DEFAULT_LAYER_CONFIG)
    const engine2 = new LayeredPriceEngine(42, DEFAULT_LAYER_CONFIG)

    const series1 = engine1.generateSeries(100, 100)
    const series2 = engine2.generateSeries(100, 100)

    expect(series1).toEqual(series2)
  })

  test('price stays positive', () => {
    const engine = new LayeredPriceEngine(12345, DEFAULT_LAYER_CONFIG)
    const series = engine.generateSeries(3000, 100)
    for (const price of series) {
      expect(price).toBeGreaterThan(0)
    }
  })
})

describe('GameEngine', () => {
  test('initializes with correct state', () => {
    const engine = new GameEngine({
      initialCapital: 1000,
      initialPrice: 100,
      initialHouseBankroll: 10000000,
      tickRateMs: 100,
      seed: 42,
    })
    const state = engine.getState()
    expect(state.capital).toBe(1000)
    expect(state.currentPrice).toBe(100)
    expect(state.position).toBeNull()
    expect(state.tickCount).toBe(0)
  })

  test('processTick advances tick count and changes price', () => {
    const engine = new GameEngine({
      initialCapital: 1000,
      initialPrice: 100,
      initialHouseBankroll: 10000000,
      tickRateMs: 100,
      seed: 42,
    })
    engine.processTick()
    const state = engine.getState()
    expect(state.tickCount).toBe(1)
    expect(state.currentPrice).not.toBe(100)
  })

  test('open_position deducts capital including spread', () => {
    const engine = new GameEngine({
      initialCapital: 1000,
      initialPrice: 100,
      initialHouseBankroll: 10000000,
      tickRateMs: 100,
      seed: 42,
    })
    engine.executeAction({
      type: 'open_position',
      direction: 'long',
      sizePercent: 0.5,
      leverage: 10,
    })
    const state = engine.getState()
    expect(state.capital).toBeLessThan(1000)
    expect(state.capital).toBeGreaterThan(0)
    expect(state.position).not.toBeNull()
    expect(state.position!.direction).toBe('long')
    expect(state.position!.leverage).toBe(10)
  })
})

describe('Session Verification', () => {
  test('verifies valid session with house seed only', () => {
    const houseSeed = 2863311530
    const houseCommitHash = sha256Hash(houseSeed)

    const input: VerificationInput = {
      houseSeed,
      houseCommitHash,
      config: {
        initialCapital: 1000,
        initialPrice: 100,
        initialHouseBankroll: 10000000,
        tickRateMs: 100,
      },
      actionLog: [
        {
          tickNumber: 10,
          action: {
            type: 'open_position',
            direction: 'long',
            sizePercent: 0.5,
            leverage: 10,
          },
          timestamp: 1706600001000,
        },
        {
          tickNumber: 50,
          action: {
            type: 'close_position',
          },
          timestamp: 1706600005000,
        },
      ],
    }

    const result = verifySession(input)
    expect(result.houseCommitmentValid).toBe(true)
    expect(result.ticksProcessed).toBeGreaterThan(0)
    expect(result.actionsExecuted).toBe(2)
    expect(result.replayedState.capital).toBeGreaterThan(0)
  })

  test('detects invalid house commitment', () => {
    const input: VerificationInput = {
      houseSeed: 12345,
      houseCommitHash: 'definitely_wrong_hash',
      config: {
        initialCapital: 1000,
        initialPrice: 100,
        initialHouseBankroll: 10000000,
        tickRateMs: 100,
      },
      actionLog: [],
    }

    const result = verifySession(input)
    expect(result.houseCommitmentValid).toBe(false)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  test('verifies session with combined seeds', () => {
    const houseSeed = 11111
    const playerSeed = 22222
    const combinedSeed = (houseSeed ^ playerSeed) >>> 0

    const input: VerificationInput = {
      houseSeed,
      houseCommitHash: sha256Hash(houseSeed),
      playerSeed,
      playerCommitHash: sha256Hash(playerSeed),
      combinedSeed,
      config: {
        initialCapital: 1000,
        initialPrice: 100,
        initialHouseBankroll: 10000000,
        tickRateMs: 100,
      },
      actionLog: [],
    }

    const result = verifySession(input)
    expect(result.houseCommitmentValid).toBe(true)
    expect(result.playerCommitmentValid).toBe(true)
    expect(result.seedCombinationValid).toBe(true)
    expect(result.valid).toBe(true)
  })

  test('replay is deterministic', () => {
    const input: VerificationInput = {
      houseSeed: 42,
      houseCommitHash: sha256Hash(42),
      config: {
        initialCapital: 1000,
        initialPrice: 100,
        initialHouseBankroll: 10000000,
        tickRateMs: 100,
      },
      actionLog: [
        {
          tickNumber: 5,
          action: { type: 'open_position', direction: 'short', sizePercent: 1.0, leverage: 5 },
          timestamp: 1000,
        },
      ],
    }

    const result1 = replaySession(input)
    const result2 = replaySession(input)

    expect(result1.finalState.capital).toBe(result2.finalState.capital)
    expect(result1.finalState.currentPrice).toBe(result2.finalState.currentPrice)
    expect(result1.ticksProcessed).toBe(result2.ticksProcessed)
  })

  test('generateVerificationReport produces readable output', () => {
    const input: VerificationInput = {
      houseSeed: 42,
      houseCommitHash: sha256Hash(42),
      config: {
        initialCapital: 1000,
        initialPrice: 100,
        initialHouseBankroll: 10000000,
        tickRateMs: 100,
      },
      actionLog: [],
    }

    const result = verifySession(input)
    const report = generateVerificationReport(result)

    expect(report).toContain('SESSION VERIFICATION REPORT')
    expect(report).toContain('VALID')
    expect(report).toContain('Capital:')
    expect(report).toContain('House commitment:')
  })
})
