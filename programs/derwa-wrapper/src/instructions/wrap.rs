use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    mint_to, transfer_checked, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
};

use crate::error::DeRwaError;
use crate::state::WrapperConfig;

/// Wrap permissioned cPOOL → freely-transferable dePOOL at 1:1.
///
/// Investor transfers `amount` cPOOL to the wrapper PDA's ATA, and the wrapper
/// program signs a `mint_to` for `amount` dePOOL into the investor's dePOOL ATA.
/// `locked_supply` increments to maintain the on-chain invariant
/// `locked_supply == dePOOL.supply`.
///
/// ─── HOOK ACCOUNT NOTE ────────────────────────────────────────────────────
/// The cPOOL `transfer_checked` CPI invokes ComplianceHook in Permissioned
/// mode. Token-2022's runtime auto-resolves the hook's ExtraAccountMetaList
/// for top-level user txs, but for a CPI like this one the CALLER must
/// pass the extra accounts in `remaining_accounts`. The current `Wrap`
/// accounts struct does NOT surface them. Three resolution paths:
///   (a) extend this struct to pass through remaining_accounts (preferred),
///   (b) gate cPOOL on a "mode = FreelyTransferable for wrapper-PDA-bound
///       transfers" rule inside compliance-hook's `execute`,
///   (c) accept that the hook MintConfig isn't initialised yet so the
///       hook is a no-op on devnet.
/// Option (c) holds for the current devnet state. Once MintConfig
/// initialisation lands, integration tests will surface the issue and
/// we'll switch to (a).
/// ──────────────────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct Wrap<'info> {
    /// Per-pool wrapper config. Mut because we increment `locked_supply`.
    /// Mint constraints validate that the (cPOOL, dePOOL) pair matches the
    /// pair this wrapper was initialised with — prevents an attacker from
    /// passing a different mint to mint themselves dePOOL out of thin air.
    #[account(
        mut,
        seeds = [WrapperConfig::SEED_PREFIX, wrapper_config.pool.as_ref()],
        bump = wrapper_config.bump,
        constraint = wrapper_config.permissioned_mint == permissioned_mint.key() @ DeRwaError::MintMismatch,
        constraint = wrapper_config.derwa_mint == derwa_mint.key() @ DeRwaError::MintMismatch,
    )]
    pub wrapper_config: Box<Account<'info, WrapperConfig>>,

    /// CHECK: PDA owning the locked cPOOL ATA + acting as dePOOL mint authority.
    /// Seeds: [b"wrapper_signer", wrapper_config.pool]. We use UncheckedAccount
    /// because this PDA holds no data — it's pure authority. The seed
    /// constraint is the validation; only the wrapper program can sign for it.
    #[account(
        seeds = [b"wrapper_signer", wrapper_config.pool.as_ref()],
        bump,
    )]
    pub wrapper_signer: UncheckedAccount<'info>,

    #[account(mut)]
    pub permissioned_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub derwa_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Investor's cPOOL ATA — source of the wrap.
    #[account(
        mut,
        token::mint = permissioned_mint,
        token::authority = investor,
    )]
    pub investor_permissioned_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Wrapper PDA's cPOOL ATA — destination of the wrap. The cPOOL stays
    /// here for the lifetime of the dePOOL position; unwrap moves it back.
    #[account(
        mut,
        token::mint = permissioned_mint,
        token::authority = wrapper_signer,
    )]
    pub wrapper_locked_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Investor's dePOOL ATA — receives the minted dePOOL.
    #[account(
        mut,
        token::mint = derwa_mint,
        token::authority = investor,
    )]
    pub investor_derwa_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub investor: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Wrap>, amount: u64) -> Result<()> {
    require!(amount > 0, DeRwaError::ZeroAmount);

    // 1. Transfer cPOOL from investor → wrapper PDA's ATA.
    //    `transfer_checked` is the Token-2022 path that respects the
    //    TransferHook extension. See HOOK ACCOUNT NOTE in the doc above for
    //    the remaining_accounts caveat.
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.investor_permissioned_ata.to_account_info(),
            mint: ctx.accounts.permissioned_mint.to_account_info(),
            to: ctx.accounts.wrapper_locked_ata.to_account_info(),
            authority: ctx.accounts.investor.to_account_info(),
        },
    );
    transfer_checked(cpi_ctx, amount, ctx.accounts.permissioned_mint.decimals)?;

    // 2. Mint dePOOL to investor (1:1).
    //
    //    Anchor's `bumps` only contains entries for accounts that were
    //    derived in this ix's accounts struct. `wrapper_signer` IS one of
    //    those (via the `seeds = [...]` constraint above), so
    //    `ctx.bumps.wrapper_signer` is the canonical bump.
    let pool_key = ctx.accounts.wrapper_config.pool;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"wrapper_signer",
        pool_key.as_ref(),
        &[ctx.bumps.wrapper_signer],
    ]];
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo {
            mint: ctx.accounts.derwa_mint.to_account_info(),
            to: ctx.accounts.investor_derwa_ata.to_account_info(),
            authority: ctx.accounts.wrapper_signer.to_account_info(),
        },
        signer_seeds,
    );
    mint_to(cpi_ctx, amount)?;

    // 3. Update locked_supply. Per spec — overflow at u64::MAX cPOOL is
    //    practically impossible (would require ~1.8e19 token base units of
    //    real-world credit) and the program panic is acceptable for that
    //    theoretical edge. If product later wants a graceful error, add a
    //    `LockedSupplyOverflow` variant to DeRwaError and switch to
    //    `checked_add(...).ok_or(...)?`.
    let cfg = &mut ctx.accounts.wrapper_config;
    cfg.locked_supply = cfg.locked_supply.checked_add(amount).unwrap();

    msg!(
        "wrap | investor={} amount={} new_locked={}",
        ctx.accounts.investor.key(),
        amount,
        cfg.locked_supply,
    );
    Ok(())
}
