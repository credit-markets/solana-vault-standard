use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::state::WrapperConfig;

/// Bind a pool to its (cPOOL, dePOOL) mint pair.
///
/// Pre-conditions (enforced by the broader system, not by this ix):
///   1. The cPOOL mint exists with ComplianceHook in Permissioned mode
///      (created in Plan C Task 3 inside `initialize_pool`).
///   2. The dePOOL mint exists with ComplianceHook in FreelyTransferable mode
///      (created in Plan C Task 5b's `create-derwa-mint.ts` script). Note that
///      Task 5b currently DEFERS MintConfig + ExtraAccountMetaList init to the
///      Plan C Task 14 deployment runbook — see the script's KNOWN GAP header.
///   3. The dePOOL mint authority is the `wrapper_signer` PDA (set by Task 5b).
///
/// Anchor doesn't reach into the mint extensions to validate (1) and (2) here
/// — the cross-plan invariant is enforced at the binding sites (Task 3 for
/// cPOOL, Task 5b for dePOOL). This handler just records the binding so
/// `wrap` and `unwrap` can dispatch against the correct mints.
#[derive(Accounts)]
pub struct InitializeWrapper<'info> {
    /// CHECK: pool's CreditVault PDA. Stored verbatim into `WrapperConfig.pool`.
    /// We don't deserialize because that would couple derwa-wrapper to svs-11's
    /// IDL (creating a circular build-time dep). The pool's CreditVault PDA is
    /// validated implicitly via the `wrapper_config` seed derivation: anyone
    /// passing a non-pool key here would derive a different `wrapper_config`
    /// PDA, which Anchor's `init` constraint would either succeed at (binding
    /// to the bogus key — harmless because no SVS-11 ix references it) or
    /// fail at if the bogus PDA already exists.
    pub pool: UncheckedAccount<'info>,

    /// Per-pool wrapper config. One per pool — Anchor's `init` constraint
    /// forbids re-init, which is the lock that prevents an attacker from
    /// re-binding the pool to a different (cPOOL, dePOOL) pair.
    #[account(
        init,
        payer = payer,
        space = WrapperConfig::SPACE,
        seeds = [WrapperConfig::SEED_PREFIX, pool.key().as_ref()],
        bump,
    )]
    pub wrapper_config: Account<'info, WrapperConfig>,

    /// Token-2022 cPOOL mint. Resolved via `InterfaceAccount` so Token-2022
    /// extensions (TransferHook etc.) deserialize correctly.
    pub permissioned_mint: InterfaceAccount<'info, Mint>,

    /// Token-2022 dePOOL mint (FreelyTransferable hook).
    pub derwa_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeWrapper>) -> Result<()> {
    let cfg = &mut ctx.accounts.wrapper_config;
    cfg.pool = ctx.accounts.pool.key();
    cfg.permissioned_mint = ctx.accounts.permissioned_mint.key();
    cfg.derwa_mint = ctx.accounts.derwa_mint.key();
    cfg.locked_supply = 0;
    cfg.bump = ctx.bumps.wrapper_config;

    msg!(
        "WrapperConfig initialized | pool={} permissioned={} derwa={}",
        cfg.pool,
        cfg.permissioned_mint,
        cfg.derwa_mint,
    );
    Ok(())
}
