# Chipsum

Chipsum is a provably fair trading game where players trade a synthetic price feed. The price movement is deterministic from a pre-committed seed, enabling independent verification that the house never manipulates outcomes.

This repository contains:

1. **Verification package** (`verify/`) — Standalone tools to independently verify any game session was fair
2. **Smart contract source** (`contracts/`) — Solana programs deployed on-chain for deposits, escrow, and LP management

## How Provable Fairness Works

Every game session follows a commit-reveal protocol:

1. **House commits**: Before the player joins, the house generates a random seed and publishes its SHA-256 hash (the commitment)
2. **Player contributes**: The player can optionally contribute their own seed
3. **Seeds combine**: Both seeds are XORed together to produce the final game seed
4. **Game plays**: The combined seed deterministically generates all price movements, turbo directions, and other randomness
5. **Seeds revealed**: After the session ends, both seeds are revealed. Anyone can verify:
   - The house seed matches the original commitment hash
   - The combined seed was correctly computed
   - Replaying the session with that seed produces identical results

Because the house commits its seed hash before the player acts, the house cannot change the outcome after seeing the player's decisions.

## Verifying a Session

### Install from npm

```bash
npm install -g chipsum-verify
```

Or run directly with npx (no install required):

```bash
npx chipsum-verify session.json
```

### Getting Your Session Data

After a session ends, download your verification file from the server:

```
GET /api/sessions/{sessionId}/verification-data
```

This returns a JSON file containing everything needed to independently replay and verify the session: seeds, configuration, and the full action log.

In a browser, this endpoint triggers a file download (`session-{id}.json`). You can also fetch it programmatically:

```bash
curl -o session.json https://your-server/api/sessions/{sessionId}/verification-data
```

### CLI Usage

```bash
# Verify and print human-readable report
npx chipsum-verify session.json

# Output as JSON
npx chipsum-verify session.json -f json

# Write report to file
npx chipsum-verify session.json -o report.txt

# Verbose mode (shows seed info)
npx chipsum-verify session.json -v
```

Example output:

```
============================================================
SESSION VERIFICATION REPORT
============================================================

Overall Result: VALID

Commitment Verification:
  House commitment: valid
  Player commitment: valid
  Seed combination: valid

Replay Summary:
  Ticks processed: 110
  Actions executed: 4

Final State:
  Capital: $1018.77
  Current price: $102.20

State Comparison:
  Match: valid

============================================================
```

### Full Verification Flow

1. Play a session on Chipsum
2. When the session ends, the house seed is revealed
3. Download your session data: `GET /api/sessions/{id}/verification-data`
4. Run verification: `npx chipsum-verify session.json`
5. The tool replays every tick deterministically from the seed and confirms:
   - The house seed matches the hash committed before you played
   - Your player seed was correctly combined with the house seed
   - Replaying all price movements and your actions produces the exact same final state

If any of these checks fail, the session is flagged as invalid.

### Input Format

The verification input is a JSON file containing the session's seeds, configuration, and action log:

```json
{
  "houseSeed": 2863311530,
  "houseCommitHash": "0afa8c80b21a4d1c...",
  "playerSeed": 67890,
  "playerCommitHash": "abc123...",
  "combinedSeed": 2863278640,
  "config": {
    "initialCapital": 1000,
    "initialPrice": 100,
    "initialHouseBankroll": 10000000,
    "tickRateMs": 100
  },
  "actionLog": [
    {
      "tickNumber": 10,
      "action": { "type": "open_position", "direction": "long", "sizePercent": 0.5, "leverage": 10 },
      "timestamp": 1706600001000
    }
  ],
  "expectedFinalState": {
    "capital": 950.25,
    "tickCount": 110,
    "totalProfit": 12.50,
    "totalLosses": 62.25
  }
}
```

### Programmatic API

```typescript
import { verifySession, hashSeed, verifySeedCommitment } from 'chipsum-verify'

// Quick commitment check
const isValid = verifySeedCommitment(12345, 'expected_hash...')

// Full session verification
const result = verifySession({
  houseSeed: 12345,
  houseCommitHash: hashSeed(12345),
  config: { initialCapital: 1000, initialPrice: 100, initialHouseBankroll: 10000000, tickRateMs: 100 },
  actionLog: [],
})

console.log(result.valid)           // true/false
console.log(result.replayedState)   // Final game state from replay
```

## Game Mechanics

### Products

| Product | Description | House Edge |
|---------|-------------|------------|
| Directional positions | Long/short with 1-1000x leverage | 0.5% spread + 10%/hr funding |
| Binary options | Call/put with 2-100x multipliers | ~2% built into strike distance |
| Turbo | 10% price move in random direction (50/50) | 1% of notional in turbo points |
| Shield | Protection from liquidation (1 second per buy) | 0.66% of notional in turbo points |

### Price Engine

The price engine uses layered coefficients with independent entropy per layer:

- **Sign**: Fair 50/50 direction (up or down)
- **Magnitude**: Base move size (0.05-0.25% per tick)
- **Volatility**: Occasional 2-4x spikes (2% chance per tick)
- **Momentum**: Mild trend continuation with decay
- **Reversion**: Slow pull toward moving average
- **Drift correction**: Cancels momentum-induced positive drift

Each layer draws from an independently seeded PRNG (Mulberry32), derived from the master game seed via label-based hashing.

## Smart Contracts

Two Solana programs are deployed on devnet:

### Lockbox (`9ivinBudGu2LvutszVaw6LLMXDfhELt8cGQ7npmBMw2q`)

Bidirectional SOL-to-CHIPS conversion at a fixed rate (1 SOL = 1000 CHIPS).

- `initialize` — Create SOL vault and CHIPS mint
- `deposit_sol` — Deposit SOL, receive CHIPS
- `withdraw_sol` — Burn CHIPS, receive SOL

### Housebox (`BnoLdADTpKY8zvW7ZoDWvPexQwYuTReDpy7r5ZzaCiGu`)

LP pool, player escrow, and settlement.

- `initialize` / `initialize_vault` — Two-step program setup
- `lp_lock` — LP deposits CHIPS, receives vCHIPS (80/20 split with protocol)
- `request_redemption` / `execute_redemption` — Time-locked LP withdrawal (60s delay)
- `player_deposit` — Player deposits CHIPS to escrow
- `player_settle` — Server settles session P&L (server-signed)
- `player_withdraw` — Player withdraws from escrow (server-authorized)
- `pause` / `unpause` — Emergency protocol controls

### Building Contracts

Requires Solana toolchain with Anchor 0.29.0:

```bash
cd contracts
cargo build-sbf
```

## Project Structure

```
chipsum-open/
├── README.md
├── LICENSE
├── contracts/                    # Solana smart contracts
│   ├── Cargo.toml
│   └── programs/
│       ├── lockbox/              # SOL <-> CHIPS conversion
│       └── housebox/             # LP pool, escrow, settlement
└── verify/                       # Verification package
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── index.ts              # Public API exports
    │   ├── crypto/seeds.ts       # SHA-256 hashing, seed verification
    │   ├── engine/
    │   │   ├── rng.ts            # Mulberry32 PRNG
    │   │   ├── priceEngine.ts    # Layered price generation
    │   │   └── optionPricing.ts  # Strike calculation
    │   ├── game/
    │   │   ├── types.ts          # All game type definitions
    │   │   ├── constants.ts      # Game rate constants
    │   │   ├── positionMath.ts   # P&L, liquidation math
    │   │   ├── houseEdge.ts      # Edge calculations
    │   │   └── gameEngine.ts     # Full game engine
    │   ├── verify/
    │   │   ├── types.ts          # Verification I/O types
    │   │   ├── commitments.ts    # Seed commitment checks
    │   │   ├── replay.ts         # Deterministic session replay
    │   │   ├── verify.ts         # Orchestrator
    │   │   └── report.ts         # Report generation
    │   └── cli/index.ts          # CLI entry point
    ├── examples/
    │   └── sample-session.json
    └── tests/
        └── verify.test.ts
```

## License

MIT
