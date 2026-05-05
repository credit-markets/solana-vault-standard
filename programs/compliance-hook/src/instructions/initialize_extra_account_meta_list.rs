use anchor_lang::prelude::*;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::state::{ComplianceMode, MintConfig, SanctionsList};

/// Token-2022 TransferHook spec: this PDA tells the runtime which accounts
/// beyond the canonical 4 (source, mint, destination, owner) `execute`
/// consumes. The seed is a fixed literal string per the spec — do NOT
/// change it. Note the HYPHEN (not underscore): the Token-2022 program
/// looks up exactly `b"extra-account-metas"`.
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

/// Capacity sized for max-case (`Permissioned` mode = 7 extras) so that
/// a later `set_compliance_mode` admin call can mutate the mode in
/// place without reallocating this PDA. The
/// `FreelyTransferable` mode underuses the slack, but the per-PDA waste
/// (~3 ExtraAccountMeta entries = ~105 bytes) is acceptable in exchange
/// for avoiding realloc CPIs on mode switches.
const MAX_EXTRA_METAS: usize = 7;

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    /// PDA at the canonical Token-2022 seed; payer initializes.
    /// CHECK: validated via the seed constraint + the manual-capacity
    /// budget passed to `space`. Anchor's `init` constraint guards
    /// re-initialization (returns `account already in use`).
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(MAX_EXTRA_METAS).unwrap(),
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    /// CHECK: the Token-2022 mint this hook is bound to. We do NOT
    /// validate the mint's TransferHook extension authority here — the
    /// mint creation flows (cPOOL via SVS-11 `initialize_pool`; dePOOL
    /// via the deRWA wrapper init) own that wiring and call this
    /// instruction as a CPI from those entry points. The
    /// `mint_authority` signer below provides the access-control gate.
    pub mint: UncheckedAccount<'info>,

    /// Per-mint configuration. Mode is read directly via the typed
    /// `Account<'info, MintConfig>` wrapper, which Anchor validates
    /// against the canonical seeds before this handler runs — safer
    /// than a raw byte read.
    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint.key().as_ref()],
        bump,
        seeds::program = crate::ID,
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// Mint authority — MUST be the `Mint::mint_authority` recorded on
    /// the bound Token-2022 mint. The handler verifies this by reading
    /// the unpacked mint state and comparing with `mint_authority.key()`,
    /// rejecting with `UnauthorizedAuthority` on mismatch. Without this
    /// check, any signer could write the EAML for any mint (the
    /// extra-account-meta-list PDA is seeded only by `mint`), which would
    /// let a stranger pin a mint's hook-extra resolution to whatever
    /// account list they choose. This is distinct from
    /// `Mint::transfer_hook_authority`, which lives in the TransferHook
    /// extension and gates mint-level hook re-binding rather than
    /// per-mint EAML init.
    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeExtraAccountMetaList>) -> Result<()> {
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token_2022::spl_token_2022;
    use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;

    // Reject legacy SPL mints — only Token-2022 mints can carry a
    // TransferHook extension. Without this guard, the EAML init would
    // succeed against a legacy mint, producing a configuration the
    // runtime would never invoke.
    require_keys_eq!(
        *ctx.accounts.mint.owner,
        spl_token_2022::id(),
        crate::error::ComplianceHookError::InvalidMintAccount
    );

    // (audit #9) Verify the signer is the actual mint authority. The
    // mint-config init does this; without it here, a stranger could
    // race-create the EAML for a mint that has a MintConfig (or one
    // they're about to MintConfig themselves), pinning it to the wrong
    // EAML. Reading mint_authority off the unpacked mint avoids relying
    // on the EAML PDA's `init` constraint as the only access gate.
    let mint_data = ctx.accounts.mint.try_borrow_data()?;
    let mint_state = Token2022Mint::unpack(&mint_data[..Token2022Mint::LEN])
        .map_err(|_| crate::error::ComplianceHookError::InvalidMintAccount)?;
    let mint_authority_opt: Option<Pubkey> = mint_state.mint_authority.into();
    let actual_authority: Pubkey = mint_authority_opt
        .ok_or(crate::error::ComplianceHookError::UnauthorizedAuthority)?;
    drop(mint_data); // release the borrow before further mut access below.
    require_keys_eq!(
        actual_authority,
        ctx.accounts.mint_authority.key(),
        crate::error::ComplianceHookError::UnauthorizedAuthority
    );

    let mode = ctx.accounts.mint_config.mode;
    let extra_metas = build_extra_account_metas(mode)?;

    let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &extra_metas)?;

    msg!(
        "ExtraAccountMetaList initialized | mint={} mode={:?} extras={}",
        ctx.accounts.mint.key(),
        mode,
        extra_metas.len()
    );
    Ok(())
}

/// Build the `ExtraAccountMeta` vector for a given compliance mode.
///
/// Order matters: the Token-2022 runtime appends these entries to the
/// canonical 4 accounts (source_ata, mint, destination_ata, source_owner)
/// when invoking `execute`, in the exact order returned here. Any
/// reordering invalidates the `Seed::AccountKey` / `Seed::AccountData`
/// indices used for derivation.
///
/// Index layout in `execute`'s account list after resolution:
///   0 source_ata          (canonical)
///   1 mint                (canonical)
///   2 destination_ata     (canonical)
///   3 source_owner        (canonical)
///   4 mint_config         (FIRST extra)
///   5 sanctions_list
///   6 source_frozen_check
///   7 destination_frozen_check
///   8 source_attestation       (Permissioned only)
///   9 destination_attestation  (Permissioned only)
///   10 pool_policy             (Permissioned only)
fn build_extra_account_metas(mode: ComplianceMode) -> Result<Vec<ExtraAccountMeta>> {
    let mut v = vec![
        // mint_config: PDA at [b"mint_config", mint] under our program.
        // The `mint` is canonical account index 1.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: MintConfig::SEED_PREFIX.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false, // is_signer
            false, // is_writable
        )?,
        // sanctions_list: singleton PDA at [b"sanctions_list"].
        ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal {
                bytes: SanctionsList::SEED_PREFIX.to_vec(),
            }],
            false,
            false,
        )?,
        // source_frozen_check: PDA at [b"frozen", source_owner].
        // `source_owner` lives at bytes 32..64 of `source_ata` (canonical
        // index 0) per the SPL Token-2022 account layout.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: b"frozen".to_vec(),
                },
                Seed::AccountData {
                    account_index: 0,
                    data_index: 32,
                    length: 32,
                },
            ],
            false,
            false,
        )?,
        // destination_frozen_check: same shape, sourced from
        // `destination_ata` (canonical index 2).
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: b"frozen".to_vec(),
                },
                Seed::AccountData {
                    account_index: 2,
                    data_index: 32,
                    length: 32,
                },
            ],
            false,
            false,
        )?,
    ];

    if mode == ComplianceMode::Permissioned {
        // ── ITERATION-2 KNOWN GAP — EAML attestation seed mismatch ────
        // The two `attestation` extras below derive PDAs using the
        // single-seed convention `[b"attestation", owner]` under THIS
        // program (compliance-hook) — but the canonical SVS-11 / mock-sas
        // attestation PDAs are seeded as
        // `[b"attestation", subject, issuer, attestation_type]` under the
        // attestation PROGRAM (not compliance-hook).
        //
        // Consequences with the current wiring:
        //   - The Token-2022 runtime resolves a PDA that does NOT exist
        //     (no one creates accounts at this address), so the runtime
        //     passes a default-zero account.
        //   - `execute::check_attestation` then fails with
        //     `AttestationNotFound` (6002) on the existence check.
        //   - Net effect: Permissioned mode is fail-CLOSED at runtime
        //     (no transfer can succeed). It is NOT exploitable, but it
        //     is also NOT functional.
        //
        // The defense-in-depth validation in `check_attestation` (owner
        // / subject / issuer / type / canonical PDA) makes the failure
        // mode safe even if a user tries to manually pass a different
        // account list to the hook program directly.
        //
        // The proper fix (iteration 2) requires `new_external_pda_with_seeds`
        // with `program_index` pointing to a fixed account whose key
        // equals `mint_config.attestation_program`, plus seeds
        // `[Literal(b"attestation"), AccountData(source_ata bytes 32..64),
        // AccountData(mint_config.attestation_issuer field),
        // AccountData(mint_config.attestation_type byte)]`. That requires
        // adding an `attestation_program` extra account (capacity bump to
        // 8) and updating the mint-config init flow to bake in the
        // attestation program key. Documented in
        // docs/compliance-hook.md "Iteration 2 follow-ups".

        // source_attestation: PLACEHOLDER seed (see KNOWN GAP above).
        v.push(ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: b"attestation".to_vec(),
                },
                Seed::AccountData {
                    account_index: 0,
                    data_index: 32,
                    length: 32,
                },
            ],
            false,
            false,
        )?);
        // destination_attestation: PLACEHOLDER seed (see KNOWN GAP above).
        v.push(ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: b"attestation".to_vec(),
                },
                Seed::AccountData {
                    account_index: 2,
                    data_index: 32,
                    length: 32,
                },
            ],
            false,
            false,
        )?);
        // pool_policy: read from `mint_config.pool_policy` field.
        //
        // CRITICAL: `account_index` MUST be 4, NOT 5.
        // The Token-2022 runtime resolves `Seed::AccountData` against
        // the COMPLETE account list (canonical 4 + already-pushed
        // extras), so:
        //   0 = source_ata          (canonical)
        //   1 = mint                (canonical)
        //   2 = destination_ata     (canonical)
        //   3 = source_owner        (canonical)
        //   4 = mint_config         (FIRST extra — pushed first above)
        //   5 = sanctions_list      (second extra)
        //   ...
        // An earlier draft used `account_index: 5`, which would read
        // `sanctions_list` bytes and produce a garbage PDA derivation
        // that fails every Permissioned-mode transfer.
        //
        // `pool_policy` field offset within `MintConfig` account data:
        //   discriminator(8) + mint(32) + mode(1) + Option tag(1) = 42
        // The 32-byte pubkey then sits at bytes 42..74. The `Option`
        // tag at offset 41 is 0=None / 1=Some; the seed derivation only
        // makes sense when tag=1 (Permissioned mode binds a policy).
        v.push(ExtraAccountMeta::new_with_seeds(
            &[Seed::AccountData {
                account_index: 4,
                data_index: 8 + 32 + 1 + 1,
                length: 32,
            }],
            false,
            false,
        )?);
    }

    Ok(v)
}
