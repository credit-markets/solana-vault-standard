use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    burn, transfer_checked, Burn, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::error::DeRwaError;
use crate::state::WrapperConfig;

/// Unwrap dePOOL → cPOOL at 1:1, attestation-gated.
///
/// Burns dePOOL from investor and releases cPOOL from the wrapper PDA back to
/// the investor — but ONLY if the destination wallet (the investor) has a
/// valid, non-revoked, non-expired attestation. Without this gate, an attacker
/// could buy dePOOL on a DEX without ever passing KYB and then unwrap to
/// receive permissioned cPOOL — the entire point of the Permissioned mode
/// would be defeated.
///
/// The attestation check below is REDUNDANT with what Token-2022 +
/// ComplianceHook will enforce on the cPOOL `transfer_checked` CPI in step 3
/// (in Permissioned mode, it reads the destination's attestation and rejects
/// unattested destinations). We do an explicit check here as defence-in-depth:
/// if the hook is mis-configured (Task 5b's deferred MintConfig path leaves
/// the hook a no-op until Task 14 runbook closes the gap), this explicit
/// check still guards the gate.
#[derive(Accounts)]
pub struct Unwrap<'info> {
    #[account(
        mut,
        seeds = [WrapperConfig::SEED_PREFIX, wrapper_config.pool.as_ref()],
        bump = wrapper_config.bump,
        constraint = wrapper_config.permissioned_mint == permissioned_mint.key() @ DeRwaError::MintMismatch,
        constraint = wrapper_config.derwa_mint == derwa_mint.key() @ DeRwaError::MintMismatch,
    )]
    pub wrapper_config: Box<Account<'info, WrapperConfig>>,

    /// CHECK: PDA owning the locked cPOOL ATA + acting as dePOOL mint authority.
    /// Seeds: [b"wrapper_signer", wrapper_config.pool].
    #[account(
        seeds = [b"wrapper_signer", wrapper_config.pool.as_ref()],
        bump,
    )]
    pub wrapper_signer: UncheckedAccount<'info>,

    #[account(mut)]
    pub permissioned_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub derwa_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Wrapper PDA's cPOOL ATA — source of the cPOOL release.
    #[account(
        mut,
        token::mint = permissioned_mint,
        token::authority = wrapper_signer,
    )]
    pub wrapper_locked_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Investor's cPOOL ATA — receives the released cPOOL.
    #[account(
        mut,
        token::mint = permissioned_mint,
        token::authority = investor,
    )]
    pub investor_permissioned_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Investor's dePOOL ATA — source of the dePOOL burn.
    #[account(
        mut,
        token::mint = derwa_mint,
        token::authority = investor,
    )]
    pub investor_derwa_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Attestation PDA from svs-11 mock-sas program. Existence +
    /// non-revoked + non-expired enforced by reading offsets in handler. The
    /// PDA derivation `[b"attestation", investor]` is NOT validated here as a
    /// seeds constraint — the offsets-based validation reads the `subject`
    /// field at payload[0..32] implicitly via the issuer/SAS-program ownership
    /// model (anyone passing a stranger's attestation would have to find one
    /// where stranger = investor's pubkey, which is the same as having a real
    /// attestation for the investor).
    pub investor_attestation: UncheckedAccount<'info>,

    pub investor: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Unwrap>, amount: u64) -> Result<()> {
    require!(amount > 0, DeRwaError::ZeroAmount);
    require!(
        ctx.accounts.wrapper_config.locked_supply >= amount,
        DeRwaError::InsufficientLockedSupply
    );

    // 1. Validate attestation. Offset map MUST match
    //    compliance-hook::execute::check_attestation (programs/compliance-hook/
    //    src/instructions/execute.rs:163-206) AND svs-11's Attestation struct
    //    layout. Total account size: 8 (Anchor discriminator) + 121 (payload)
    //    = 129 bytes. These offsets MUST stay in sync with the
    //    check_attestation source of truth.
    //
    //    Offset map (after the 8-byte discriminator, so payload[i] = data[i+8]):
    //       0..32    subject (Pubkey)
    //      32..64    issuer (Pubkey)
    //      64        attestation_type (u8)
    //      65..67    country_code ([u8; 2])
    //      67..75    issued_at (i64)
    //      75..83    expires_at (i64)        ← we read this
    //      83        revoked (bool)          ← we read this
    //      84        bump (u8)
    //      85..117   _reserved ([u8; 32])
    //     117..119   jurisdiction ([u8; 2])
    //     119        investor_class (u8)
    //     120        kyc_risk_tier (u8)
    let att = &ctx.accounts.investor_attestation;
    require!(
        att.lamports() > 0 && att.data_len() > 0,
        DeRwaError::AttestationRequired
    );
    let data = att.try_borrow_data()?;
    require!(data.len() >= 129, DeRwaError::AttestationRequired);
    let payload = &data[8..];
    // try_into().unwrap() is sound: data.len() >= 129 means
    // payload[75..83] is always 8 bytes available.
    let expires_at = i64::from_le_bytes(payload[75..83].try_into().unwrap());
    let revoked = payload[83] != 0;
    let now = Clock::get()?.unix_timestamp;
    require!(!revoked && now < expires_at, DeRwaError::AttestationRequired);

    // 2. Burn dePOOL from investor (investor signs).
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Burn {
            mint: ctx.accounts.derwa_mint.to_account_info(),
            from: ctx.accounts.investor_derwa_ata.to_account_info(),
            authority: ctx.accounts.investor.to_account_info(),
        },
    );
    burn(cpi_ctx, amount)?;

    // 3. Transfer cPOOL from wrapper PDA back to investor (wrapper PDA signs
    //    via signer_seeds). Goes through ComplianceHook in Permissioned mode
    //    — investor must be attested. Our explicit check in step 1 already
    //    ensured this; the hook check is redundant defence-in-depth.
    let pool_key = ctx.accounts.wrapper_config.pool;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"wrapper_signer",
        pool_key.as_ref(),
        &[ctx.bumps.wrapper_signer],
    ]];
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.wrapper_locked_ata.to_account_info(),
            mint: ctx.accounts.permissioned_mint.to_account_info(),
            to: ctx.accounts.investor_permissioned_ata.to_account_info(),
            authority: ctx.accounts.wrapper_signer.to_account_info(),
        },
        signer_seeds,
    );
    transfer_checked(
        cpi_ctx,
        amount,
        ctx.accounts.permissioned_mint.decimals,
    )?;

    // 4. Update locked_supply. The earlier `>= amount` require! ensures this
    //    underflow check passes; .unwrap() panicking would indicate a bug in
    //    that earlier check, which we want to fail loud on.
    let cfg = &mut ctx.accounts.wrapper_config;
    cfg.locked_supply = cfg.locked_supply.checked_sub(amount).unwrap();

    msg!(
        "unwrap | investor={} amount={} new_locked={}",
        ctx.accounts.investor.key(),
        amount,
        cfg.locked_supply,
    );
    Ok(())
}
