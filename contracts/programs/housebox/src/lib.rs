use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

declare_id!("CQ3JPdmZfES8xkUSjBNgzJ3Y1BQqViweL23vkgKmbjDc");

/// Default LP percentage (80% to LP, 20% to protocol)
pub const DEFAULT_LP_PERCENT: u8 = 80;

/// Redemption delay in seconds (1 minute)
pub const REDEMPTION_DELAY_SECONDS: i64 = 60;

/// Redemption expiry window in seconds (1 minute after maturity)
pub const REDEMPTION_EXPIRY_SECONDS: i64 = 60;

#[program]
pub mod housebox {
    use super::*;

    /// Initialize the Housebox program (step 1: state + vToken mint).
    /// Call initialize_vault after this to create the SOL vault and protocol account.
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
        state.vtoken_mint = ctx.accounts.vtoken_mint.key();
        state.lp_percent = lp_percent;
        state.paused = false;
        state.solsum = 0;
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
        state.sol_vault_bump = ctx.bumps.sol_vault;
        state.protocol_vtoken_account = ctx.accounts.protocol_vtoken_account.key();

        msg!("Housebox vault initialized (step 2)");

        Ok(())
    }

    /// LP locks SOL in the house, receives vTokens.
    /// Rate-aware minting: vTokens minted proportional to pool share.
    pub fn lp_lock(ctx: Context<LpLock>, amount_lamports: u64) -> Result<()> {
        let state = &ctx.accounts.housebox_state;
        require!(!state.paused, HouseboxError::ProtocolPaused);
        require!(amount_lamports > 0, HouseboxError::ZeroAmount);

        // Transfer SOL from LP to vault
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.lp.to_account_info(),
                    to: ctx.accounts.sol_vault.to_account_info(),
                },
            ),
            amount_lamports,
        )?;

        // Rate-aware vToken minting
        let solsum = ctx.accounts.housebox_state.solsum;
        let vsum = ctx.accounts.housebox_state.vsum;

        let vtokens_to_mint = if solsum == 0 && vsum == 0 {
            // Bootstrap: 1:1 ratio (lamports to vTokens)
            amount_lamports
        } else {
            // Proportional: vtokens = amount * vsum / solsum
            (amount_lamports as u128)
                .checked_mul(vsum as u128)
                .ok_or(HouseboxError::MathOverflow)?
                .checked_div(solsum as u128)
                .ok_or(HouseboxError::MathOverflow)? as u64
        };

        require!(vtokens_to_mint > 0, HouseboxError::AmountTooSmall);

        // Split: LP gets lp_percent, protocol gets the rest
        let lp_vtokens = vtokens_to_mint
            .checked_mul(ctx.accounts.housebox_state.lp_percent as u64)
            .ok_or(HouseboxError::MathOverflow)?
            .checked_div(100)
            .ok_or(HouseboxError::MathOverflow)?;

        let protocol_vtokens = vtokens_to_mint.checked_sub(lp_vtokens)
            .ok_or(HouseboxError::MathOverflow)?;

        // Mint vTokens to LP
        let seeds = &[
            b"housebox_state".as_ref(),
            &[ctx.bumps.housebox_state],
        ];
        let signer_seeds = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::MintTo {
                    mint: ctx.accounts.vtoken_mint.to_account_info(),
                    to: ctx.accounts.lp_vtoken_account.to_account_info(),
                    authority: ctx.accounts.housebox_state.to_account_info(),
                },
                signer_seeds,
            ),
            lp_vtokens,
        )?;

        // Mint vTokens to protocol
        if protocol_vtokens > 0 {
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    token::MintTo {
                        mint: ctx.accounts.vtoken_mint.to_account_info(),
                        to: ctx.accounts.protocol_vtoken_account.to_account_info(),
                        authority: ctx.accounts.housebox_state.to_account_info(),
                    },
                    signer_seeds,
                ),
                protocol_vtokens,
            )?;
        }

        // Update state
        let state = &mut ctx.accounts.housebox_state;
        state.solsum = state.solsum.checked_add(amount_lamports)
            .ok_or(HouseboxError::MathOverflow)?;
        state.vsum = state.vsum.checked_add(vtokens_to_mint)
            .ok_or(HouseboxError::MathOverflow)?;

        msg!("LP locked {} lamports, received {} vTokens (LP: {}, Protocol: {})", amount_lamports, vtokens_to_mint, lp_vtokens, protocol_vtokens);
        msg!("Solsum: {}, Vsum: {}", state.solsum, state.vsum);

        Ok(())
    }

    /// LP requests redemption of vTokens. Records intent only — vTokens stay
    /// in LP wallet and solsum/vsum are unchanged until execute_redemption.
    /// LP bears pool risk during the 60s delay.
    pub fn request_redemption(ctx: Context<RequestRedemption>, vtoken_amount: u64) -> Result<()> {
        let state = &ctx.accounts.housebox_state;
        require!(!state.paused, HouseboxError::ProtocolPaused);
        require!(vtoken_amount > 0, HouseboxError::ZeroAmount);
        require!(state.vsum > 0, HouseboxError::NoLiquidity);

        // Create redemption request (intent only — no token operations)
        let request = &mut ctx.accounts.redemption_request;
        request.lp = ctx.accounts.lp.key();
        request.vtoken_amount = vtoken_amount;
        request.requested_at = Clock::get()?.unix_timestamp;
        request.bump = ctx.bumps.redemption_request;

        msg!("Redemption requested: {} vTokens (deferred burn)", vtoken_amount);
        msg!("Ready at timestamp: {}", request.requested_at + REDEMPTION_DELAY_SECONDS);

        Ok(())
    }

    /// Execute a redemption request after the delay period.
    /// LP must sign (needed for vToken burn authority). Burns vTokens,
    /// computes payout at execution-time ratio, decrements solsum/vsum,
    /// and transfers SOL to LP.
    pub fn execute_redemption(ctx: Context<ExecuteRedemption>) -> Result<()> {
        let request = &ctx.accounts.redemption_request;

        // Verify delay has elapsed but claim window hasn't expired
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= request.requested_at + REDEMPTION_DELAY_SECONDS,
            HouseboxError::RedemptionNotReady
        );
        require!(
            now <= request.requested_at + REDEMPTION_DELAY_SECONDS + REDEMPTION_EXPIRY_SECONDS,
            HouseboxError::RedemptionExpired
        );

        let vtoken_amount = request.vtoken_amount;

        // Verify LP still has enough vTokens
        require!(
            ctx.accounts.lp_vtoken_account.amount >= vtoken_amount,
            HouseboxError::InsufficientVtokens
        );

        // Compute sol_out at execution-time ratio
        let state = &ctx.accounts.housebox_state;
        require!(state.vsum > 0, HouseboxError::NoLiquidity);

        let sol_out = (vtoken_amount as u128)
            .checked_mul(state.solsum as u128)
            .ok_or(HouseboxError::MathOverflow)?
            .checked_div(state.vsum as u128)
            .ok_or(HouseboxError::MathOverflow)? as u64;

        require!(sol_out > 0, HouseboxError::AmountTooSmall);

        // Copy vault bump before mutable borrow
        let sol_vault_bump = ctx.accounts.housebox_state.sol_vault_bump;

        // Burn vTokens from LP
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: ctx.accounts.vtoken_mint.to_account_info(),
                    from: ctx.accounts.lp_vtoken_account.to_account_info(),
                    authority: ctx.accounts.lp.to_account_info(),
                },
            ),
            vtoken_amount,
        )?;

        // Decrement solsum and vsum
        let state = &mut ctx.accounts.housebox_state;
        state.vsum = state.vsum.checked_sub(vtoken_amount)
            .ok_or(HouseboxError::MathOverflow)?;
        state.solsum = state.solsum.checked_sub(sol_out)
            .ok_or(HouseboxError::MathOverflow)?;

        // Transfer SOL from vault to LP (PDA signer)
        let vault_seeds = &[
            b"sol_vault".as_ref(),
            &[sol_vault_bump],
        ];
        let vault_signer_seeds = &[&vault_seeds[..]];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.sol_vault.to_account_info(),
                    to: ctx.accounts.lp.to_account_info(),
                },
                vault_signer_seeds,
            ),
            sol_out,
        )?;

        // Account will be closed by Anchor's `close = lp` constraint
        msg!("Redemption executed: {} vTokens burned, {} lamports transferred to LP", vtoken_amount, sol_out);
        msg!("Solsum: {}, Vsum: {}", state.solsum, state.vsum);

        Ok(())
    }

    /// Player deposits SOL to escrow.
    pub fn player_deposit(ctx: Context<PlayerDeposit>, amount_lamports: u64) -> Result<()> {
        let state = &ctx.accounts.housebox_state;
        require!(!state.paused, HouseboxError::ProtocolPaused);
        require!(amount_lamports > 0, HouseboxError::ZeroAmount);

        // Transfer SOL from player to vault
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: ctx.accounts.sol_vault.to_account_info(),
                },
            ),
            amount_lamports,
        )?;

        // Update escrow (create if first deposit)
        let escrow = &mut ctx.accounts.player_escrow;
        escrow.player = ctx.accounts.player.key();
        escrow.balance = escrow.balance.checked_add(amount_lamports)
            .ok_or(HouseboxError::MathOverflow)?;
        escrow.bump = ctx.bumps.player_escrow;

        // Set verified withdrawal address on first deposit
        if escrow.verified_withdrawal_address == Pubkey::default() {
            escrow.verified_withdrawal_address = ctx.accounts.player.key();
            msg!("Verified withdrawal address set to: {}", ctx.accounts.player.key());
        }

        // solsum NOT affected — escrow is separate from LP pool
        msg!("Player deposited {} lamports to escrow", amount_lamports);
        msg!("Escrow balance: {}", escrow.balance);

        Ok(())
    }

    /// Settle player session P&L (server-signed).
    /// No SOL actually moves — it's all in the same vault.
    /// Just accounting entries between escrow and LP pool.
    pub fn player_settle(
        ctx: Context<PlayerSettle>,
        pnl: i64,
        session_id: [u8; 32],
    ) -> Result<()> {
        let state = &ctx.accounts.housebox_state;
        require!(!state.paused, HouseboxError::ProtocolPaused);

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
            state.solsum = state.solsum.checked_add(loss)
                .ok_or(HouseboxError::MathOverflow)?;

            msg!("Player lost {} lamports", loss);
        } else if pnl > 0 {
            // Player won
            let win = pnl as u64;
            let state_ref = &ctx.accounts.housebox_state;
            require!(state_ref.solsum >= win, HouseboxError::HouseInsolvent);

            escrow.balance = escrow.balance.checked_add(win)
                .ok_or(HouseboxError::MathOverflow)?;

            let state = &mut ctx.accounts.housebox_state;
            state.solsum = state.solsum.checked_sub(win)
                .ok_or(HouseboxError::MathOverflow)?;

            msg!("Player won {} lamports", win);
        }

        // Mark session as settled
        let settled = &mut ctx.accounts.settled_session;
        settled.session_id = session_id;
        settled.player = ctx.accounts.player.key();
        settled.settled_at = Clock::get()?.unix_timestamp;

        msg!("Session settled. Escrow balance: {}", escrow.balance);
        msg!("Solsum: {}", ctx.accounts.housebox_state.solsum);

        Ok(())
    }

    /// Player withdraws SOL from escrow (server-authorized).
    /// Withdrawals require server co-signature to prevent unauthorized withdrawals
    /// while a player has an active game session.
    pub fn player_withdraw(ctx: Context<PlayerWithdraw>, amount_lamports: u64) -> Result<()> {
        // Verify server signature matches configured server pubkey
        let state = &ctx.accounts.housebox_state;
        require!(
            ctx.accounts.server_signer.key() == state.server_pubkey,
            HouseboxError::InvalidServerSignature
        );

        // Note: Withdrawals always allowed, even when paused (after server approval)
        require!(amount_lamports > 0, HouseboxError::ZeroAmount);

        let escrow = &mut ctx.accounts.player_escrow;
        require!(escrow.balance >= amount_lamports, HouseboxError::InsufficientEscrow);

        // Verify withdrawal goes to the verified withdrawal address
        require!(
            escrow.verified_withdrawal_address == ctx.accounts.player.key(),
            HouseboxError::WithdrawalAddressMismatch
        );

        // Update escrow
        escrow.balance = escrow.balance.checked_sub(amount_lamports)
            .ok_or(HouseboxError::MathOverflow)?;

        // Transfer SOL from vault to player (PDA signer)
        let sol_vault_bump = ctx.accounts.housebox_state.sol_vault_bump;
        let vault_seeds = &[
            b"sol_vault".as_ref(),
            &[sol_vault_bump],
        ];
        let vault_signer_seeds = &[&vault_seeds[..]];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.sol_vault.to_account_info(),
                    to: ctx.accounts.player.to_account_info(),
                },
                vault_signer_seeds,
            ),
            amount_lamports,
        )?;

        msg!("Player withdrew {} lamports from escrow", amount_lamports);
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

    /// Close an expired redemption request PDA to reclaim rent.
    /// Permissionless — anyone can call. Rent returns to the LP.
    pub fn close_expired_redemption(ctx: Context<CloseExpiredRedemption>) -> Result<()> {
        let request = &ctx.accounts.redemption_request;
        let now = Clock::get()?.unix_timestamp;
        require!(
            now > request.requested_at + REDEMPTION_DELAY_SECONDS + REDEMPTION_EXPIRY_SECONDS,
            HouseboxError::RedemptionNotExpired
        );
        msg!("Closed expired redemption request, rent returned to LP");
        Ok(())
    }

    /// Close a settled session PDA to reclaim rent.
    /// Only the server can call this, and only after the session is at least 1 hour old.
    pub fn close_settled_session(
        ctx: Context<CloseSettledSession>,
        _session_id: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let age = now - ctx.accounts.settled_session.settled_at;
        require!(age >= 3600, HouseboxError::SettlementTooRecent);
        msg!("Closed settled session, rent reclaimed");
        Ok(())
    }

    /// Withdraw vTokens from the protocol account (authority only).
    /// Used to transfer protocol-held vTokens to a wallet for redemption.
    pub fn withdraw_protocol_vtokens(
        ctx: Context<WithdrawProtocolVtokens>,
        amount: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.housebox_state.authority,
            HouseboxError::Unauthorized
        );
        require!(amount > 0, HouseboxError::ZeroAmount);

        let seeds = &[
            b"housebox_state".as_ref(),
            &[ctx.bumps.housebox_state],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.protocol_vtoken_account.to_account_info(),
                    to: ctx.accounts.destination_vtoken_account.to_account_info(),
                    authority: ctx.accounts.housebox_state.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        msg!("Withdrew {} vTokens from protocol account", amount);

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

    /// vToken mint (LP share token) - Housebox is mint authority (9 decimals, matching SOL)
    #[account(
        init,
        payer = authority,
        mint::decimals = 9,
        mint::authority = housebox_state,
        seeds = [b"vtoken_mint"],
        bump
    )]
    pub vtoken_mint: Box<Account<'info, Mint>>,

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

    /// vToken mint (created in step 1)
    #[account(
        seeds = [b"vtoken_mint"],
        bump
    )]
    pub vtoken_mint: Box<Account<'info, Mint>>,

    /// SOL vault PDA - system account that holds all SOL (LP + escrow)
    /// CHECK: This is a PDA that just holds lamports, not a token account
    #[account(
        mut,
        seeds = [b"sol_vault"],
        bump
    )]
    pub sol_vault: SystemAccount<'info>,

    /// Protocol's vToken account PDA (receives LP haircut)
    #[account(
        init,
        payer = authority,
        token::mint = vtoken_mint,
        token::authority = housebox_state,
        seeds = [b"protocol_vtoken"],
        bump
    )]
    pub protocol_vtoken_account: Box<Account<'info, TokenAccount>>,

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

    /// SOL vault PDA
    /// CHECK: This is a PDA that just holds lamports
    #[account(
        mut,
        seeds = [b"sol_vault"],
        bump
    )]
    pub sol_vault: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"vtoken_mint"],
        bump
    )]
    pub vtoken_mint: Account<'info, Mint>,

    /// LP's vToken account
    #[account(
        mut,
        constraint = lp_vtoken_account.owner == lp.key(),
        constraint = lp_vtoken_account.mint == vtoken_mint.key()
    )]
    pub lp_vtoken_account: Account<'info, TokenAccount>,

    /// Protocol's vToken account
    #[account(
        mut,
        constraint = protocol_vtoken_account.key() == housebox_state.protocol_vtoken_account
    )]
    pub protocol_vtoken_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RequestRedemption<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,

    #[account(
        seeds = [b"housebox_state"],
        bump
    )]
    pub housebox_state: Account<'info, HouseboxState>,

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
}

#[derive(Accounts)]
pub struct ExecuteRedemption<'info> {
    /// LP must sign (needed for vToken burn authority)
    #[account(
        mut,
        constraint = lp.key() == redemption_request.lp @ HouseboxError::Unauthorized
    )]
    pub lp: Signer<'info>,

    #[account(
        mut,
        seeds = [b"housebox_state"],
        bump
    )]
    pub housebox_state: Account<'info, HouseboxState>,

    /// SOL vault PDA
    /// CHECK: This is a PDA that just holds lamports
    #[account(
        mut,
        seeds = [b"sol_vault"],
        bump
    )]
    pub sol_vault: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"vtoken_mint"],
        bump
    )]
    pub vtoken_mint: Account<'info, Mint>,

    /// LP's vToken account (to burn from)
    #[account(
        mut,
        constraint = lp_vtoken_account.owner == lp.key(),
        constraint = lp_vtoken_account.mint == vtoken_mint.key()
    )]
    pub lp_vtoken_account: Account<'info, TokenAccount>,

    /// Redemption request PDA (will be closed, rent returned to LP)
    #[account(
        mut,
        close = lp,
        seeds = [b"redemption", redemption_request.lp.as_ref()],
        bump = redemption_request.bump
    )]
    pub redemption_request: Account<'info, RedemptionRequest>,

    pub system_program: Program<'info, System>,
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

    /// SOL vault PDA
    /// CHECK: This is a PDA that just holds lamports
    #[account(
        mut,
        seeds = [b"sol_vault"],
        bump
    )]
    pub sol_vault: SystemAccount<'info>,

    /// Player's escrow PDA (created on first deposit)
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + PlayerEscrow::INIT_SPACE,
        seeds = [b"escrow", player.key().as_ref()],
        bump
    )]
    pub player_escrow: Account<'info, PlayerEscrow>,

    pub system_program: Program<'info, System>,
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
    #[account(mut)]
    pub player: AccountInfo<'info>,

    #[account(
        seeds = [b"housebox_state"],
        bump
    )]
    pub housebox_state: Account<'info, HouseboxState>,

    /// SOL vault PDA
    /// CHECK: This is a PDA that just holds lamports
    #[account(
        mut,
        seeds = [b"sol_vault"],
        bump
    )]
    pub sol_vault: SystemAccount<'info>,

    /// Player's escrow
    #[account(
        mut,
        seeds = [b"escrow", player.key().as_ref()],
        bump = player_escrow.bump,
        constraint = player_escrow.player == player.key()
    )]
    pub player_escrow: Account<'info, PlayerEscrow>,

    pub system_program: Program<'info, System>,
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

#[derive(Accounts)]
#[instruction(session_id: [u8; 32])]
pub struct CloseSettledSession<'info> {
    #[account(
        mut,
        constraint = server_signer.key() == housebox_state.server_pubkey @ HouseboxError::Unauthorized
    )]
    pub server_signer: Signer<'info>,

    #[account(
        seeds = [b"housebox_state"],
        bump
    )]
    pub housebox_state: Account<'info, HouseboxState>,

    #[account(
        mut,
        close = server_signer,
        seeds = [b"settled", session_id.as_ref()],
        bump
    )]
    pub settled_session: Account<'info, SettledSession>,
}

#[derive(Accounts)]
pub struct WithdrawProtocolVtokens<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"housebox_state"],
        bump
    )]
    pub housebox_state: Account<'info, HouseboxState>,

    /// Protocol's vToken account (source)
    #[account(
        mut,
        constraint = protocol_vtoken_account.key() == housebox_state.protocol_vtoken_account
    )]
    pub protocol_vtoken_account: Account<'info, TokenAccount>,

    /// Destination vToken account
    #[account(mut)]
    pub destination_vtoken_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CloseExpiredRedemption<'info> {
    /// Anyone can call (permissionless cleanup)
    #[account(mut)]
    pub caller: Signer<'info>,

    /// LP who made the request — receives rent refund
    /// CHECK: Verified by redemption_request.lp field; only receives rent
    #[account(
        mut,
        constraint = lp.key() == redemption_request.lp @ HouseboxError::Unauthorized
    )]
    pub lp: AccountInfo<'info>,

    /// Redemption request PDA (will be closed, rent returned to LP)
    #[account(
        mut,
        close = lp,
        seeds = [b"redemption", redemption_request.lp.as_ref()],
        bump = redemption_request.bump
    )]
    pub redemption_request: Account<'info, RedemptionRequest>,
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
    /// Bump for sol_vault PDA
    pub sol_vault_bump: u8,
    /// vToken mint (LP share token)
    pub vtoken_mint: Pubkey,
    /// LP's share of vTokens (e.g., 80 = 80%)
    pub lp_percent: u8,
    /// Emergency pause flag
    pub paused: bool,
    /// Total SOL (lamports) in LP pool (redeemable by vToken holders)
    pub solsum: u64,
    /// Total vTokens outstanding (redemption denominator)
    pub vsum: u64,
    /// Protocol's vToken account (receives haircut)
    pub protocol_vtoken_account: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct PlayerEscrow {
    /// Player's wallet pubkey
    pub player: Pubkey,
    /// Escrowed SOL balance (lamports)
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
    /// vToken amount to burn at execution time
    pub vtoken_amount: u64,
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
    #[msg("Settlement too recent to close (must be > 1 hour old)")]
    SettlementTooRecent,
    #[msg("LP has insufficient vTokens for redemption")]
    InsufficientVtokens,
    #[msg("Redemption claim window has expired")]
    RedemptionExpired,
    #[msg("Redemption has not expired yet")]
    RedemptionNotExpired,
}
