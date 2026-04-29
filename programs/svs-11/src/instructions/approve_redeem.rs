use anchor_lang::prelude::*;
use anchor_spl::token_2022::{self, Token2022};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::attestation::validate_attestation;
use crate::constants::{
    CLAIMABLE_TOKENS_SEED, FROZEN_ACCOUNT_SEED, NAV_ORACLE_PROGRAM_ID, NAV_ORACLE_SEED,
    ORACLE_SOURCE_MOCK, ORACLE_SOURCE_NAV_ORACLE, REDEMPTION_ESCROW_SEED, REDEMPTION_REQUEST_SEED,
    VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::RedemptionApproved;
use crate::math;
use crate::oracle::{read_and_validate_oracle, read_nav_oracle_price, OraclePrice};
use crate::state::{CreditVault, RedemptionRequest, RequestStatus};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct ApproveRedeem<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        mut,
        has_one = manager,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, CreditVault>>,

    #[account(
        mut,
        has_one = vault,
        seeds = [REDEMPTION_REQUEST_SEED, vault.key().as_ref(), redemption_request.investor.as_ref()],
        bump = redemption_request.bump,
        constraint = redemption_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
    )]
    pub redemption_request: Box<Account<'info, RedemptionRequest>>,

    #[account(constraint = investor.key() == redemption_request.investor)]
    pub investor: SystemAccount<'info>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [REDEMPTION_ESCROW_SEED, vault.key().as_ref()],
        bump = vault.redemption_escrow_bump,
    )]
    pub redemption_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = deposit_vault.key() == vault.deposit_vault,
    )]
    pub deposit_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(constraint = asset_mint.key() == vault.asset_mint)]
    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = manager,
        token::mint = asset_mint,
        token::authority = vault,
        token::token_program = asset_token_program,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub claimable_tokens: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Legacy mock-oracle account. Read in the `oracle_source == 0`
    /// branch via `read_and_validate_oracle`. Field is `nav_oracle` for
    /// backwards-compat with existing IDL clients (the underlying account
    /// has always been the mock oracle); semantically this slot holds the
    /// "mock_oracle_account" per Plan B Task 6.
    pub nav_oracle: UncheckedAccount<'info>,

    /// CHECK: NavAccount PDA from the nav-oracle program (Plan B). Read in
    /// the `oracle_source == 1` branch via `read_nav_oracle_price`.
    ///
    /// IMPORTANT (audit V1.B / P1.B): we INTENTIONALLY OMIT the
    /// `seeds = [NAV_ORACLE_SEED, vault.key().as_ref()]` + `bump` +
    /// `seeds::program = NAV_ORACLE_PROGRAM_ID` constraints here. Anchor
    /// validates seed constraints at deserialization time, BEFORE the
    /// handler runs. With seeds enforced, the emergency-revert path
    /// (`oracle_source == 0` + caller passes a dummy account because they
    /// don't have a real NavAccount yet) FAILS at pre-handler validation,
    /// defeating the entire P0.G design. See approve_deposit for full
    /// rationale.
    ///
    /// We MANUALLY validate the PDA derivation + program ownership inside
    /// the handler when `oracle_source == 1` (see branch below).
    pub nav_account: UncheckedAccount<'info>,

    /// CHECK: Attestation validated in handler via validate_attestation
    pub attestation: UncheckedAccount<'info>,

    /// CHECK: If data is non-empty, investor is frozen
    #[account(
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub frozen_check: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(ctx: Context<ApproveRedeem>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(
        ctx.accounts.frozen_check.data_is_empty(),
        VaultError::AccountFrozen
    );

    // V4-P20 FIX: Reconciliation check — verify stored total_shares matches
    // shares_mint.supply. If they diverge, something has gone wrong and we
    // should not proceed with a redemption based on stale share counts.
    require!(
        ctx.accounts.vault.total_shares == ctx.accounts.shares_mint.supply,
        VaultError::MathOverflow
    );

    validate_attestation(
        &ctx.accounts.attestation.to_account_info(),
        &ctx.accounts.vault,
        &ctx.accounts.investor.key(),
        &ctx.accounts.clock,
    )?;

    // Read NAV via the configured oracle source (P0.G emergency-revert
    // toggle). See approve_deposit for the full rationale on the audit
    // P1.B design (no seeds constraint on nav_account; manual PDA check in
    // the nav-oracle branch).
    let oracle_read: OraclePrice = match ctx.accounts.vault.oracle_source {
        ORACLE_SOURCE_NAV_ORACLE => {
            let credit_vault_key = ctx.accounts.vault.key();
            let (expected_nav_pda, _bump) = Pubkey::find_program_address(
                &[NAV_ORACLE_SEED, credit_vault_key.as_ref()],
                &NAV_ORACLE_PROGRAM_ID,
            );
            require!(
                ctx.accounts.nav_account.key() == expected_nav_pda,
                VaultError::OracleAccountInvalid
            );
            require!(
                ctx.accounts.nav_account.owner == &NAV_ORACLE_PROGRAM_ID,
                VaultError::OracleAccountInvalid
            );

            let r = read_nav_oracle_price(
                &ctx.accounts.nav_account.to_account_info(),
                &credit_vault_key,
                ctx.accounts.vault.last_seen_nav_sequence,
                ctx.accounts.vault.max_nav_staleness_secs,
                ctx.accounts.vault.max_deviation_bps,
                Some(ctx.accounts.vault.last_seen_nav_price),
            )?;
            OraclePrice {
                price: r.price,
                sequence: r.sequence,
            }
        }
        ORACLE_SOURCE_MOCK => {
            msg!(
                "WARNING: CreditVault.oracle_source=0 (mock); revert mode active. \
                 NAV freshness from nav-oracle NOT enforced."
            );
            let p = read_and_validate_oracle(
                &ctx.accounts.nav_oracle.to_account_info(),
                &ctx.accounts.vault,
                &ctx.accounts.clock,
            )?;
            OraclePrice {
                price: p,
                sequence: 0,
            }
        }
        _ => return err!(VaultError::OracleSourceInvalid),
    };

    let price = oracle_read.price;

    // V5-P9: Deviation check — compare oracle price against vault-derived expected price.
    // SVS-11 (credit vault) does not use ERC-4626-style virtual shares/assets (no
    // decimals_offset), so the simple ratio (total_assets * PRICE_SCALE / total_shares)
    // is the correct expected price. This differs from SVS-10 which uses convert_to_assets
    // with decimals_offset to account for virtual share inflation.
    let vault = &ctx.accounts.vault;
    if vault.total_shares > 0 && vault.total_assets > 0 {
        let expected_price_u128 = (vault.total_assets as u128)
            .checked_mul(svs_oracle::PRICE_SCALE as u128)
            .and_then(|v| v.checked_div(vault.total_shares as u128))
            .ok_or(VaultError::MathOverflow)?;
        require!(
            expected_price_u128 <= u64::MAX as u128,
            VaultError::MathOverflow
        );
        svs_oracle::validate_deviation(price, expected_price_u128 as u64, vault.max_deviation_bps)
            .map_err(|_| VaultError::OracleDeviationExceeded)?;
    }

    let shares_locked = ctx.accounts.redemption_request.shares_locked;
    let gross_assets = math::shares_to_assets(shares_locked, price)?;

    #[cfg(feature = "modules")]
    let net_assets = {
        let remaining = ctx.remaining_accounts;
        let vault_key = ctx.accounts.vault.key();
        let result = module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, gross_assets)?;
        result.net_assets
    };
    #[cfg(not(feature = "modules"))]
    let net_assets = gross_assets;

    require!(net_assets > 0, VaultError::ZeroAmount);

    let available = ctx
        .accounts
        .deposit_vault
        .amount
        .checked_sub(ctx.accounts.vault.total_pending_deposits)
        .and_then(|v| v.checked_sub(ctx.accounts.vault.total_approved_deposits))
        .ok_or(VaultError::MathOverflow)?;
    require!(available >= net_assets, VaultError::InsufficientLiquidity);

    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let vault_bump_bytes = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &vault_bump_bytes,
    ];

    token_2022::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            token_2022::Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.redemption_escrow.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        shares_locked,
    )?;

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.deposit_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                to: ctx.accounts.claimable_tokens.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        net_assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    let request = &mut ctx.accounts.redemption_request;
    request.status = RequestStatus::Approved;
    request.assets_claimable = net_assets;
    request.fulfilled_at = ctx.accounts.clock.unix_timestamp;

    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_sub(net_assets)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_sub(shares_locked)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_pending_redeems = vault
        .total_pending_redeems
        .checked_sub(1)
        .ok_or(VaultError::MathOverflow)?;

    // Persist NAV bookkeeping (mirrors approve_deposit). Sequence is only
    // advanced for the nav-oracle path; mock returns sentinel 0.
    vault.last_seen_nav_price = price;
    if vault.oracle_source == ORACLE_SOURCE_NAV_ORACLE {
        vault.last_seen_nav_sequence = oracle_read.sequence;
    }

    emit!(RedemptionApproved {
        vault: vault.key(),
        investor: ctx.accounts.investor.key(),
        shares: shares_locked,
        assets: net_assets,
        nav: price,
    });

    Ok(())
}
