use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

declare_id!("BnoLdADTpKY8zvW7ZoDWvPexQwYuTReDpy7r5ZzaCiGu");

/// Default LP percentage (80% to LP, 20% to protocol)
pub const DEFAULT_LP_PERCENT: u8 = 80;

/// Redemption delay in seconds (1 minute)
pub const REDEMPTION_DELAY_SECONDS: i64 = 60;

#[program]
pub mod housebox {
    use super::*;

    /// Initialize the Housebox program (step 1: state + vCHIPS mint).
    /// Call initialize_vault after this to create the CHIPS vault and protocol account.
    pub fn initialize(
        ctx: Context<Initialize>,
        server_pubkey: Pubkey,
        lp_percent: u8,
    ) -> Result<()> {
        require!(lp_percent > 0 && lp_percent <= 100, HouseboxError::InvalidLpPercent);

        let state = &mut ctx.accounts.housebox_state;
        state.authority = ctx.accounts.authority.key();
        state.server_pubkey = server_pubkey;
        state.pause_authority = ctx.accounts.authority.key();
        state.chips_mint = ctx.accounts.chips_mint.key();
        state.vchips_mint = ctx.accounts.vchips_mint.key();
        state.lp_percent = lp_percent;
        state.paused = false;
        state.chipsum = 0;
        state.vsum = 0;

        msg!("Housebox initialized (step 1)");
        msg!("Server pubkey: {}", server_pubkey);
        msg!("LP percent: {}%", lp_percent);

        Ok(())
    }

    /// Initialize vault and protocol account (step 2).
    /// Must be called after initialize.
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let state = &mut ctx.accounts.housebox_state;
        state.chips_vault_bump = ctx.bumps.chips_vault;
        state.protocol_vchips_account = ctx.accounts.protocol_vchips_account.key();

        msg!("Housebox vault initialized (step 2)");

        Ok(())
    }

    /// LP locks CHIPS in the house, receives vCHIPS.
    pub fn lp_lock(ctx: Context<LpLock>, chips_amount: u64) -> Result<()> {
        let state = &ctx.accounts.housebox_state;
        require!(!state.paused, HouseboxError::ProtocolPaused);
        require!(chips_amount > 0, HouseboxError::ZeroAmount);

        // Transfer CHIPS from LP to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.lp_chips_account.to_account_info(),
                    to: ctx.accounts.chips_vault.to_account_info(),
                    authority: ctx.accounts.lp.to_account_info(),
                },
            ),
            chips_amount,
        )?;

        // Calculate vCHIPS distribution
        let lp_vchips = chips_amount
            .checked_mul(ctx.accounts.housebox_state.lp_percent as u64)
            .ok_or(HouseboxError::MathOverflow)?
            .checked_div(100)
            .ok_or(HouseboxError::MathOverflow)?;

        let protocol_vchips = chips_amount.checked_sub(lp_vchips)
            .ok_or(HouseboxError::MathOverflow)?;

        // Mint vCHIPS to LP
        let seeds = &[
            b"housebox_state".as_ref(),
            &[ctx.bumps.housebox_state],
        ];
        let signer_seeds = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::MintTo {
                    mint: ctx.accounts.vchips_mint.to_account_info(),
                    to: ctx.accounts.lp_vchips_account.to_account_info(),
                    authority: ctx.accounts.housebox_state.to_account_info(),
                },
                signer_seeds,
            ),
            lp_vchips,
        )?;

        // Mint vCHIPS to protocol
        if protocol_vchips > 0 {
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    token::MintTo {
                        mint: ctx.accounts.vchips_mint.to_account_info(),
                        to: ctx.accounts.protocol_vchips_account.to_account_info(),
                        authority: ctx.accounts.housebox_state.to_account_info(),
                    },
                    signer_seeds,
                ),
                protocol_vchips,
            )?;
        }

        // Update state
        let state = &mut ctx.accounts.housebox_state;
        state.chipsum = state.chipsum.checked_add(chips_amount)
            .ok_or(HouseboxError::MathOverflow)?;
        state.vsum = state.vsum.checked_add(chips_amount)
            .ok_or(HouseboxError::MathOverflow)?;

        msg!("LP locked {} CHIPS, received {} vCHIPS", chips_amount, lp_vchips);
        msg!("Protocol received {} vCHIPS", protocol_vchips);
        msg!("Chipsum: {}, Vsum: {}", state.chipsum, state.vsum);

        Ok(())
    }

    /// LP requests redemption of vCHIPS. Burns vCHIPS immediately,
    /// calculates CHIPS owed at current ratio, and creates a time-locked request.
    /// CHIPS are reserved (chipsum decremented) but not transferred until execute.
    pub fn request_redemption(ctx: Context<RequestRedemption>, vchips_amount: u64) -> Result<()> {
        let state = &ctx.accounts.housebox_state;
        require!(!state.paused, HouseboxError::ProtocolPaused);
        require!(vchips_amount > 0, HouseboxError::ZeroAmount);
        require!(state.vsum > 0, HouseboxError::NoLiquidity);

        // Calculate CHIPS to return: (vchips_amount / vsum) * chipsum
        let chips_out = (vchips_amount as u128)
            .checked_mul(state.chipsum as u128)
            .ok_or(HouseboxError::MathOverflow)?
            .checked_div(state.vsum as u128)
            .ok_or(HouseboxError::MathOverflow)? as u64;

        require!(chips_out > 0, HouseboxError::AmountTooSmall);

        // Burn vCHIPS from LP
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: ctx.accounts.vchips_mint.to_account_info(),
                    from: ctx.accounts.lp_vchips_account.to_account_info(),
                    authority: ctx.accounts.lp.to_account_info(),
                },
            ),
            vchips_amount,
        )?;

        // Update state: decrement vsum AND chipsum (reserve CHIPS)
        let state = &mut ctx.accounts.housebox_state;
        state.vsum = state.vsum.checked_sub(vchips_amount)
            .ok_or(HouseboxError::MathOverflow)?;
        state.chipsum = state.chipsum.checked_sub(chips_out)
            .ok_or(HouseboxError::MathOverflow)?;

        // Create redemption request
        let request = &mut ctx.accounts.redemption_request;
        request.lp = ctx.accounts.lp.key();
        request.vchips_burned = vchips_amount;
        request.chips_owed = chips_out;
        request.requested_at = Clock::get()?.unix_timestamp;
        request.bump = ctx.bumps.redemption_request;

        msg!("Redemption requested: {} vCHIPS burned, {} CHIPS owed", vchips_amount, chips_out);
        msg!("Ready at timestamp: {}", request.requested_at + REDEMPTION_DELAY_SECONDS);
        msg!("Chipsum: {}, Vsum: {}", state.chipsum, state.vsum);

        Ok(())
    }

    /// Execute a redemption request after the delay period.
    /// Anyone can call this (enables bots/cranks). Rent returns to LP.
    pub fn execute_redemption(ctx: Context<ExecuteRedemption>) -> Result<()> {
        let request = &ctx.accounts.redemption_request;

        // Verify delay has elapsed
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= request.requested_at + REDEMPTION_DELAY_SECONDS,
            HouseboxError::RedemptionNotReady
        );

        let chips_owed = request.chips_owed;

        // Transfer CHIPS from vault to LP
        let seeds = &[
            b"chips_vault".as_ref(),
            &[ctx.accounts.housebox_state.chips_vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.chips_vault.to_account_info(),
                    to: ctx.accounts.lp_chips_account.to_account_info(),
                    authority: ctx.accounts.chips_vault.to_account_info(),
                },
                signer_seeds,
            ),
            chips_owed,
        )?;

        // Account will be closed by Anchor's `close = lp` constraint
        msg!("Redemption executed: {} CHIPS transferred to LP", chips_owed);

        Ok(())
    }

    /// Player deposits CHIPS to escrow.
    pub fn player_deposit(ctx: Context<PlayerDeposit>, chips_amount: u64) -> Result<()> {
        let state = &ctx.accounts.housebox_state;
        require!(!state.paused, HouseboxError::ProtocolPaused);
        require!(chips_amount > 0, HouseboxError::ZeroAmount);

        // Transfer CHIPS from player to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.player_chips_account.to_account_info(),
                    to: ctx.accounts.chips_vault.to_account_info(),
                    authority: ctx.accounts.player.to_account_info(),
                },
            ),
            chips_amount,
        )?;

        // Update escrow (create if first deposit)
        let escrow = &mut ctx.accounts.player_escrow;
        escrow.player = ctx.accounts.player.key();
        escrow.balance = escrow.balance.checked_add(chips_amount)
            .ok_or(HouseboxError::MathOverflow)?;
        escrow.bump = ctx.bumps.player_escrow;

        // Set verified withdrawal address on first deposit
        if escrow.verified_withdrawal_address == Pubkey::default() {
            escrow.verified_withdrawal_address = ctx.accounts.player.key();
            msg!("Verified withdrawal address set to: {}", ctx.accounts.player.key());
        }

        msg!("Player deposited {} CHIPS to escrow", chips_amount);
        msg!("Escrow balance: {}", escrow.balance);

        Ok(())
    }

    /// Settle player session P&L (server-signed).
    pub fn player_settle(
        ctx: Context<PlayerSettle>,
        pnl: i64,
        session_id: [u8; 32],
    ) -> Result<()> {
        let state = &ctx.accounts.housebox_state;
        require!(!state.paused, HouseboxError::ProtocolPaused);

        // Note: In production, verify Ed25519 signature here
        // For now, we trust the server_signer matches server_pubkey
        require!(
            ctx.accounts.server_signer.key() == state.server_pubkey,
            HouseboxError::InvalidServerSignature
        );

        let escrow = &mut ctx.accounts.player_escrow;

        if pnl < 0 {
            // Player lost
            let loss = (-pnl) as u64;
            require!(escrow.balance >= loss, HouseboxError::InsufficientEscrow);

            escrow.balance = escrow.balance.checked_sub(loss)
                .ok_or(HouseboxError::MathOverflow)?;

            let state = &mut ctx.accounts.housebox_state;
            state.chipsum = state.chipsum.checked_add(loss)
                .ok_or(HouseboxError::MathOverflow)?;

            msg!("Player lost {} CHIPS", loss);
        } else if pnl > 0 {
            // Player won
            let win = pnl as u64;
            let state_ref = &ctx.accounts.housebox_state;
            require!(state_ref.chipsum >= win, HouseboxError::HouseInsolvent);

            escrow.balance = escrow.balance.checked_add(win)
                .ok_or(HouseboxError::MathOverflow)?;

            let state = &mut ctx.accounts.housebox_state;
            state.chipsum = state.chipsum.checked_sub(win)
                .ok_or(HouseboxError::MathOverflow)?;

            msg!("Player won {} CHIPS", win);
        }

        // Mark session as settled
        let settled = &mut ctx.accounts.settled_session;
        settled.session_id = session_id;
        settled.player = ctx.accounts.player.key();
        settled.settled_at = Clock::get()?.unix_timestamp;

        msg!("Session settled. Escrow balance: {}", escrow.balance);
        msg!("Chipsum: {}", ctx.accounts.housebox_state.chipsum);

        Ok(())
    }

    /// Player withdraws from escrow (server-authorized).
    /// Withdrawals require server co-signature to prevent unauthorized withdrawals
    /// while a player has an active game session.
    pub fn player_withdraw(ctx: Context<PlayerWithdraw>, chips_amount: u64) -> Result<()> {
        // Verify server signature matches configured server pubkey
        let state = &ctx.accounts.housebox_state;
        require!(
            ctx.accounts.server_signer.key() == state.server_pubkey,
            HouseboxError::InvalidServerSignature
        );

        // Note: Withdrawals always allowed, even when paused (after server approval)
        require!(chips_amount > 0, HouseboxError::ZeroAmount);

        let escrow = &mut ctx.accounts.player_escrow;
        require!(escrow.balance >= chips_amount, HouseboxError::InsufficientEscrow);

        // Verify withdrawal goes to the verified withdrawal address
        require!(
            escrow.verified_withdrawal_address == ctx.accounts.player.key(),
            HouseboxError::WithdrawalAddressMismatch
        );

        // Update escrow
        escrow.balance = escrow.balance.checked_sub(chips_amount)
            .ok_or(HouseboxError::MathOverflow)?;

        // Transfer CHIPS from vault to player
        let seeds = &[
            b"chips_vault".as_ref(),
            &[ctx.accounts.housebox_state.chips_vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.chips_vault.to_account_info(),
                    to: ctx.accounts.player_chips_account.to_account_info(),
                    authority: ctx.accounts.chips_vault.to_account_info(),
                },
                signer_seeds,
            ),
            chips_amount,
        )?;

        msg!("Player withdrew {} CHIPS from escrow", chips_amount);
        msg!("Remaining escrow balance: {}", escrow.balance);

        Ok(())
    }

    /// Pause the protocol (admin only).
    pub fn pause(ctx: Context<AdminAction>) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.housebox_state.pause_authority,
            HouseboxError::Unauthorized
        );

        let state = &mut ctx.accounts.housebox_state;
        state.paused = true;

        msg!("Protocol PAUSED");

        Ok(())
    }

    /// Unpause the protocol (admin only).
    pub fn unpause(ctx: Context<AdminAction>) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.housebox_state.pause_authority,
            HouseboxError::Unauthorized
        );

        let state = &mut ctx.accounts.housebox_state;
        state.paused = false;

        msg!("Protocol UNPAUSED");

        Ok(())
    }

    /// Update server signing pubkey (authority only).
    pub fn update_server_pubkey(
        ctx: Context<AdminAction>,
        new_server_pubkey: Pubkey,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.housebox_state.authority,
            HouseboxError::Unauthorized
        );

        let state = &mut ctx.accounts.housebox_state;
        let old_pubkey = state.server_pubkey;
        state.server_pubkey = new_server_pubkey;

        msg!("Server pubkey updated");
        msg!("Old: {}", old_pubkey);
        msg!("New: {}", new_server_pubkey);

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
        space = 8 + HouseboxState::INIT_SPACE,
        seeds = [b"housebox_state"],
        bump
    )]
    pub housebox_state: Box<Account<'info, HouseboxState>>,

    /// CHIPS token mint (from Lockbox)
    pub chips_mint: Box<Account<'info, Mint>>,

    /// vCHIPS token mint - Housebox is mint authority
    #[account(
        init,
        payer = authority,
        mint::decimals = 0,
        mint::authority = housebox_state,
        seeds = [b"vchips_mint"],
        bump
    )]
    pub vchips_mint: Box<Account<'info, Mint>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"housebox_state"],
        bump,
        constraint = housebox_state.authority == authority.key() @ HouseboxError::Unauthorized
    )]
    pub housebox_state: Box<Account<'info, HouseboxState>>,

    /// CHIPS token mint (from Lockbox, stored in state)
    #[account(
        constraint = chips_mint.key() == housebox_state.chips_mint @ HouseboxError::Unauthorized
    )]
    pub chips_mint: Box<Account<'info, Mint>>,

    /// vCHIPS token mint (created in step 1)
    #[account(
        seeds = [b"vchips_mint"],
        bump
    )]
    pub vchips_mint: Box<Account<'info, Mint>>,

    /// CHIPS vault PDA - holds all CHIPS (LP + escrow)
    #[account(
        init,
        payer = authority,
        token::mint = chips_mint,
        token::authority = chips_vault,
        seeds = [b"chips_vault"],
        bump
    )]
    pub chips_vault: Box<Account<'info, TokenAccount>>,

    /// Protocol's vCHIPS account PDA (receives LP haircut)
    #[account(
        init,
        payer = authority,
        token::mint = vchips_mint,
        token::authority = housebox_state,
        seeds = [b"protocol_vchips"],
        bump
    )]
    pub protocol_vchips_account: Box<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct LpLock<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,

    #[account(
        mut,
        seeds = [b"housebox_state"],
        bump
    )]
    pub housebox_state: Account<'info, HouseboxState>,

    #[account(
        mut,
        seeds = [b"chips_vault"],
        bump
    )]
    pub chips_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vchips_mint"],
        bump
    )]
    pub vchips_mint: Account<'info, Mint>,

    /// LP's CHIPS account
    #[account(
        mut,
        constraint = lp_chips_account.owner == lp.key()
    )]
    pub lp_chips_account: Account<'info, TokenAccount>,

    /// LP's vCHIPS account
    #[account(
        mut,
        constraint = lp_vchips_account.owner == lp.key(),
        constraint = lp_vchips_account.mint == vchips_mint.key()
    )]
    pub lp_vchips_account: Account<'info, TokenAccount>,

    /// Protocol's vCHIPS account
    #[account(
        mut,
        constraint = protocol_vchips_account.key() == housebox_state.protocol_vchips_account
    )]
    pub protocol_vchips_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RequestRedemption<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,

    #[account(
        mut,
        seeds = [b"housebox_state"],
        bump
    )]
    pub housebox_state: Account<'info, HouseboxState>,

    #[account(
        mut,
        seeds = [b"vchips_mint"],
        bump
    )]
    pub vchips_mint: Account<'info, Mint>,

    /// LP's vCHIPS account (to burn from)
    #[account(
        mut,
        constraint = lp_vchips_account.owner == lp.key(),
        constraint = lp_vchips_account.mint == vchips_mint.key()
    )]
    pub lp_vchips_account: Account<'info, TokenAccount>,

    /// Redemption request PDA (one per LP)
    #[account(
        init,
        payer = lp,
        space = 8 + RedemptionRequest::INIT_SPACE,
        seeds = [b"redemption", lp.key().as_ref()],
        bump
    )]
    pub redemption_request: Account<'info, RedemptionRequest>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExecuteRedemption<'info> {
    /// Anyone can call (enables bots/cranks)
    #[account(mut)]
    pub caller: Signer<'info>,

    /// LP who made the request — receives rent refund
    /// CHECK: Verified by redemption_request constraint
    #[account(
        mut,
        constraint = lp.key() == redemption_request.lp @ HouseboxError::Unauthorized
    )]
    pub lp: AccountInfo<'info>,

    #[account(
        seeds = [b"housebox_state"],
        bump
    )]
    pub housebox_state: Account<'info, HouseboxState>,

    #[account(
        mut,
        seeds = [b"chips_vault"],
        bump
    )]
    pub chips_vault: Account<'info, TokenAccount>,

    /// LP's CHIPS account (where CHIPS are sent)
    #[account(
        mut,
        constraint = lp_chips_account.owner == lp.key()
    )]
    pub lp_chips_account: Account<'info, TokenAccount>,

    /// Redemption request PDA (will be closed, rent returned to LP)
    #[account(
        mut,
        close = lp,
        seeds = [b"redemption", redemption_request.lp.as_ref()],
        bump = redemption_request.bump
    )]
    pub redemption_request: Account<'info, RedemptionRequest>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PlayerDeposit<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        seeds = [b"housebox_state"],
        bump
    )]
    pub housebox_state: Account<'info, HouseboxState>,

    #[account(
        mut,
        seeds = [b"chips_vault"],
        bump
    )]
    pub chips_vault: Account<'info, TokenAccount>,

    /// Player's escrow PDA (created on first deposit)
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + PlayerEscrow::INIT_SPACE,
        seeds = [b"escrow", player.key().as_ref()],
        bump
    )]
    pub player_escrow: Account<'info, PlayerEscrow>,

    /// Player's CHIPS account
    #[account(
        mut,
        constraint = player_chips_account.owner == player.key()
    )]
    pub player_chips_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(pnl: i64, session_id: [u8; 32])]
pub struct PlayerSettle<'info> {
    /// Server signer (must match housebox_state.server_pubkey)
    #[account(mut)]
    pub server_signer: Signer<'info>,

    /// Player being settled (not signer)
    /// CHECK: We just need the pubkey for escrow lookup
    pub player: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"housebox_state"],
        bump
    )]
    pub housebox_state: Account<'info, HouseboxState>,

    /// Player's escrow
    #[account(
        mut,
        seeds = [b"escrow", player.key().as_ref()],
        bump = player_escrow.bump
    )]
    pub player_escrow: Account<'info, PlayerEscrow>,

    /// Settled session PDA (for replay protection)
    #[account(
        init,
        payer = server_signer,
        space = 8 + SettledSession::INIT_SPACE,
        seeds = [b"settled", session_id.as_ref()],
        bump
    )]
    pub settled_session: Account<'info, SettledSession>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlayerWithdraw<'info> {
    /// Server signer (must match housebox_state.server_pubkey)
    /// Required to authorize withdrawals - players cannot withdraw directly
    #[account(mut)]
    pub server_signer: Signer<'info>,

    /// Player whose escrow is being withdrawn from (not a signer)
    /// CHECK: We just need the pubkey for escrow lookup and destination validation
    pub player: AccountInfo<'info>,

    #[account(
        seeds = [b"housebox_state"],
        bump
    )]
    pub housebox_state: Account<'info, HouseboxState>,

    #[account(
        mut,
        seeds = [b"chips_vault"],
        bump
    )]
    pub chips_vault: Account<'info, TokenAccount>,

    /// Player's escrow
    #[account(
        mut,
        seeds = [b"escrow", player.key().as_ref()],
        bump = player_escrow.bump,
        constraint = player_escrow.player == player.key()
    )]
    pub player_escrow: Account<'info, PlayerEscrow>,

    /// Player's CHIPS account (where withdrawn CHIPS go)
    #[account(
        mut,
        constraint = player_chips_account.owner == player.key()
    )]
    pub player_chips_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"housebox_state"],
        bump
    )]
    pub housebox_state: Account<'info, HouseboxState>,
}

// ============================================
// STATE
// ============================================

#[account]
#[derive(InitSpace)]
pub struct HouseboxState {
    /// Program upgrade authority
    pub authority: Pubkey,
    /// Server's signing key for settlements
    pub server_pubkey: Pubkey,
    /// Who can pause/unpause
    pub pause_authority: Pubkey,
    /// CHIPS token mint (from Lockbox)
    pub chips_mint: Pubkey,
    /// vCHIPS token mint
    pub vchips_mint: Pubkey,
    /// Bump for chips_vault PDA
    pub chips_vault_bump: u8,
    /// LP's share of vCHIPS (e.g., 80 = 80%)
    pub lp_percent: u8,
    /// Emergency pause flag
    pub paused: bool,
    /// Total CHIPS in LP pool (redeemable by vCHIP holders)
    pub chipsum: u64,
    /// Total vCHIPS ever minted (redemption denominator)
    pub vsum: u64,
    /// Protocol's vCHIPS account (receives haircut)
    pub protocol_vchips_account: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct PlayerEscrow {
    /// Player's wallet pubkey
    pub player: Pubkey,
    /// Escrowed CHIPS balance
    pub balance: u64,
    /// PDA bump
    pub bump: u8,
    /// Verified withdrawal address (set on first deposit, checked on withdraw)
    pub verified_withdrawal_address: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct SettledSession {
    /// Unique session identifier
    pub session_id: [u8; 32],
    /// Player who was settled
    pub player: Pubkey,
    /// When settlement occurred
    pub settled_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct RedemptionRequest {
    /// LP who requested redemption
    pub lp: Pubkey,
    /// vCHIPS amount that was burned
    pub vchips_burned: u64,
    /// CHIPS owed to LP (calculated at request time)
    pub chips_owed: u64,
    /// Unix timestamp when request was made
    pub requested_at: i64,
    /// PDA bump
    pub bump: u8,
}

// ============================================
// ERRORS
// ============================================

#[error_code]
pub enum HouseboxError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Amount too small after calculation")]
    AmountTooSmall,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Protocol is paused")]
    ProtocolPaused,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid LP percent (must be 1-100)")]
    InvalidLpPercent,
    #[msg("No liquidity in house")]
    NoLiquidity,
    #[msg("Insufficient escrow balance")]
    InsufficientEscrow,
    #[msg("House is insolvent - cannot pay winnings")]
    HouseInsolvent,
    #[msg("Invalid server signature")]
    InvalidServerSignature,
    #[msg("Withdrawal destination does not match verified address")]
    WithdrawalAddressMismatch,
    #[msg("Redemption delay not yet elapsed")]
    RedemptionNotReady,
}
