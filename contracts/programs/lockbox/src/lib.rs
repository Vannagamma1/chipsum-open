use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

declare_id!("9ivinBudGu2LvutszVaw6LLMXDfhELt8cGQ7npmBMw2q");

/// Conversion rate: 1 SOL = 1000 CHIPS
pub const CHIPS_PER_SOL: u64 = 1000;
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

#[program]
pub mod lockbox {
    use super::*;

    /// Initialize the Lockbox program.
    /// Creates the SOL vault and CHIPS mint.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let state = &mut ctx.accounts.lockbox_state;
        state.authority = ctx.accounts.authority.key();
        state.sol_vault_bump = ctx.bumps.sol_vault;
        state.chips_mint = ctx.accounts.chips_mint.key();
        state.chips_per_sol = CHIPS_PER_SOL;
        state.total_sol_deposited = 0;

        msg!("Lockbox initialized");
        msg!("CHIPS mint: {}", state.chips_mint);
        msg!("Conversion rate: {} CHIPS per SOL", CHIPS_PER_SOL);

        Ok(())
    }

    /// Deposit SOL and receive CHIPS.
    ///
    /// # Arguments
    /// * `amount_lamports` - Amount of SOL to deposit (in lamports)
    pub fn deposit_sol(ctx: Context<DepositSol>, amount_lamports: u64) -> Result<()> {
        require!(amount_lamports > 0, LockboxError::ZeroAmount);

        // Calculate CHIPS to mint
        // chips = lamports * CHIPS_PER_SOL / LAMPORTS_PER_SOL
        let chips_amount = amount_lamports
            .checked_mul(CHIPS_PER_SOL)
            .ok_or(LockboxError::MathOverflow)?
            .checked_div(LAMPORTS_PER_SOL)
            .ok_or(LockboxError::MathOverflow)?;

        require!(chips_amount > 0, LockboxError::AmountTooSmall);

        // Transfer SOL from user to vault
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.sol_vault.to_account_info(),
                },
            ),
            amount_lamports,
        )?;

        // Mint CHIPS to user
        let seeds = &[
            b"lockbox_state".as_ref(),
            &[ctx.bumps.lockbox_state],
        ];
        let signer_seeds = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::MintTo {
                    mint: ctx.accounts.chips_mint.to_account_info(),
                    to: ctx.accounts.user_chips_account.to_account_info(),
                    authority: ctx.accounts.lockbox_state.to_account_info(),
                },
                signer_seeds,
            ),
            chips_amount,
        )?;

        // Update state
        let state = &mut ctx.accounts.lockbox_state;
        state.total_sol_deposited = state.total_sol_deposited
            .checked_add(amount_lamports)
            .ok_or(LockboxError::MathOverflow)?;

        msg!("Deposited {} lamports, minted {} CHIPS", amount_lamports, chips_amount);

        Ok(())
    }

    /// Withdraw SOL by burning CHIPS.
    ///
    /// # Arguments
    /// * `chips_amount` - Amount of CHIPS to burn
    pub fn withdraw_sol(ctx: Context<WithdrawSol>, chips_amount: u64) -> Result<()> {
        require!(chips_amount > 0, LockboxError::ZeroAmount);

        // Calculate SOL to return
        // lamports = chips * LAMPORTS_PER_SOL / CHIPS_PER_SOL
        let lamports_amount = chips_amount
            .checked_mul(LAMPORTS_PER_SOL)
            .ok_or(LockboxError::MathOverflow)?
            .checked_div(CHIPS_PER_SOL)
            .ok_or(LockboxError::MathOverflow)?;

        require!(lamports_amount > 0, LockboxError::AmountTooSmall);

        // Verify vault has enough SOL
        require!(
            ctx.accounts.sol_vault.lamports() >= lamports_amount,
            LockboxError::InsufficientVaultBalance
        );

        // Burn CHIPS from user
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: ctx.accounts.chips_mint.to_account_info(),
                    from: ctx.accounts.user_chips_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            chips_amount,
        )?;

        // Transfer SOL from vault to user using PDA signing
        let vault_seeds = &[
            b"sol_vault".as_ref(),
            &[ctx.bumps.sol_vault],
        ];
        let signer_seeds = &[&vault_seeds[..]];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.sol_vault.to_account_info(),
                    to: ctx.accounts.user.to_account_info(),
                },
                signer_seeds,
            ),
            lamports_amount,
        )?;

        // Update state
        let state = &mut ctx.accounts.lockbox_state;
        state.total_sol_deposited = state.total_sol_deposited
            .checked_sub(lamports_amount)
            .ok_or(LockboxError::MathOverflow)?;

        msg!("Burned {} CHIPS, withdrew {} lamports", chips_amount, lamports_amount);

        Ok(())
    }
}

// ============================================
// ACCOUNTS
// ============================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + LockboxState::INIT_SPACE,
        seeds = [b"lockbox_state"],
        bump
    )]
    pub lockbox_state: Account<'info, LockboxState>,

    /// SOL vault PDA - holds all deposited SOL
    #[account(
        mut,
        seeds = [b"sol_vault"],
        bump
    )]
    /// CHECK: This is a PDA that just holds SOL
    pub sol_vault: AccountInfo<'info>,

    /// CHIPS token mint - Lockbox is mint authority
    #[account(
        init,
        payer = authority,
        mint::decimals = 0,
        mint::authority = lockbox_state,
        seeds = [b"chips_mint"],
        bump
    )]
    pub chips_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"lockbox_state"],
        bump
    )]
    pub lockbox_state: Account<'info, LockboxState>,

    /// SOL vault PDA
    #[account(
        mut,
        seeds = [b"sol_vault"],
        bump
    )]
    /// CHECK: This is a PDA that just holds SOL
    pub sol_vault: AccountInfo<'info>,

    /// CHIPS mint
    #[account(
        mut,
        seeds = [b"chips_mint"],
        bump
    )]
    pub chips_mint: Account<'info, Mint>,

    /// User's CHIPS token account
    #[account(
        mut,
        constraint = user_chips_account.mint == chips_mint.key(),
        constraint = user_chips_account.owner == user.key()
    )]
    pub user_chips_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"lockbox_state"],
        bump
    )]
    pub lockbox_state: Account<'info, LockboxState>,

    /// SOL vault PDA
    #[account(
        mut,
        seeds = [b"sol_vault"],
        bump
    )]
    /// CHECK: This is a PDA that just holds SOL
    pub sol_vault: AccountInfo<'info>,

    /// CHIPS mint
    #[account(
        mut,
        seeds = [b"chips_mint"],
        bump
    )]
    pub chips_mint: Account<'info, Mint>,

    /// User's CHIPS token account
    #[account(
        mut,
        constraint = user_chips_account.mint == chips_mint.key(),
        constraint = user_chips_account.owner == user.key()
    )]
    pub user_chips_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

// ============================================
// STATE
// ============================================

#[account]
#[derive(InitSpace)]
pub struct LockboxState {
    /// Program authority (can upgrade)
    pub authority: Pubkey,
    /// Bump seed for sol_vault PDA
    pub sol_vault_bump: u8,
    /// CHIPS token mint address
    pub chips_mint: Pubkey,
    /// Conversion rate (CHIPS per SOL)
    pub chips_per_sol: u64,
    /// Total SOL deposited (for tracking)
    pub total_sol_deposited: u64,
}

// ============================================
// ERRORS
// ============================================

#[error_code]
pub enum LockboxError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Amount too small after conversion")]
    AmountTooSmall,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Insufficient SOL in vault")]
    InsufficientVaultBalance,
}
