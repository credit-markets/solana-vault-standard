use anchor_lang::prelude::*;

use crate::state::{ComplianceMode, MintConfig};

/// Args for `initialize_mint_config`. Carries the per-mint enforcement
/// posture so the hook's `execute` ix can branch on it without further
/// state lookup.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct InitializeMintConfigArgs {
    /// Mode this mint operates under. `FreelyTransferable` skips
    /// attestation checks (used for dePOOL-style freely-transferable
    /// wrappers); `Permissioned` enforces source+destination attestations
    /// every transfer.
    pub mode: ComplianceMode,
    /// Optional pool-policy PDA. Only meaningful in `Permissioned` mode
    /// where it gates jurisdiction / investor-class / KYC-tier rules.
    /// `None` for `FreelyTransferable` mints.
    pub pool_policy: Option<Pubkey>,
}

/// Initializes the per-mint config PDA that the `execute` hook reads on
/// every transfer.
///
/// Authorization: the signer MUST be the Token-2022 mint authority for
/// the bound mint. Token-2022's `Mint::mint_authority` is a `COption`
/// (`Option`-shaped); we read it via `mint.mint_authority` and compare to
/// the signer's pubkey, rejecting if the mint is uninitialized or the
/// signer doesn't match.
///
/// The `payer` exists so a separate operator key (cheaper to fund) can
/// pay rent without holding mint authority. This is the common deploy
/// pattern: a "deployer" funds account creation; a "mint authority"
/// (often a PDA from another program) approves the binding.
#[derive(Accounts)]
#[instruction(args: InitializeMintConfigArgs)]
pub struct InitializeMintConfig<'info> {
    #[account(
        init,
        payer = payer,
        space = MintConfig::SPACE,
        seeds = [MintConfig::SEED_PREFIX, mint.key().as_ref()],
        bump,
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// CHECK: Token-2022 mint we're binding to. We read `mint_authority`
    /// off the deserialized mint state in the handler — Anchor doesn't
    /// know about Token-2022 extensions in the IDL but the raw account
    /// data is canonical SPL Token, so a manual unpack reads the
    /// `mint_authority` field at the standard offset.
    pub mint: AccountInfo<'info>,

    /// Mint authority signer — must match `mint.mint_authority`. The
    /// handler verifies this; failure yields `UnauthorizedAuthority`.
    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeMintConfig>,
    args: InitializeMintConfigArgs,
) -> Result<()> {
    // Read the SPL-Token / Token-2022 Mint to verify mint_authority.
    // We use anchor_spl::token_2022::spl_token_2022::state::Mint::unpack
    // so this works for both legacy SPL Token mints and Token-2022
    // mints (the base layout is identical; extensions live AFTER it).
    use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;
    use anchor_lang::solana_program::program_pack::Pack;

    let mint_data = ctx.accounts.mint.try_borrow_data()?;
    let mint_state = Token2022Mint::unpack(&mint_data[..Token2022Mint::LEN])
        .map_err(|_| crate::error::ComplianceHookError::InvalidMintAccount)?;

    // mint_authority is COption<Pubkey>: None for fixed-supply mints
    // (which can't have a MintConfig anyway since no one can authorize
    // the binding). We refuse those explicitly. The intermediate
    // `Option<Pubkey>` annotation pins COption's `Into` impl.
    let mint_authority_opt: Option<Pubkey> = mint_state.mint_authority.into();
    let actual_authority: Pubkey = mint_authority_opt
        .ok_or(crate::error::ComplianceHookError::UnauthorizedAuthority)?;

    require_keys_eq!(
        actual_authority,
        ctx.accounts.mint_authority.key(),
        crate::error::ComplianceHookError::UnauthorizedAuthority
    );

    // Defensive: pool_policy MUST be Some when mode is Permissioned, and
    // MUST be None when mode is FreelyTransferable. Mixing them silently
    // would let a Permissioned mint skip policy checks (because
    // ExtraAccountMetaList wouldn't resolve a pool_policy account at all
    // when the field is None) — which would defeat the point of
    // Permissioned mode.
    match (args.mode, args.pool_policy) {
        (ComplianceMode::Permissioned, None) => {
            return err!(
                crate::error::ComplianceHookError::MissingPoolPolicyForPermissioned
            );
        }
        (ComplianceMode::FreelyTransferable, Some(_)) => {
            return err!(
                crate::error::ComplianceHookError::PoolPolicySetOnFreelyTransferable
            );
        }
        _ => {}
    }

    let cfg = &mut ctx.accounts.mint_config;
    cfg.mint = ctx.accounts.mint.key();
    cfg.mode = args.mode;
    cfg.pool_policy = args.pool_policy;

    msg!(
        "MintConfig initialized | mint={} mode={:?} pool_policy={:?}",
        cfg.mint,
        cfg.mode,
        cfg.pool_policy,
    );
    Ok(())
}
