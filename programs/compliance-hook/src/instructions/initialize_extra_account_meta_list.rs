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

/// Capacity sized for max-case (`Permissioned` mode = 7 extras) so that a
/// later `set_compliance_mode` admin call (Plan A Task 8 mode-switch path)
/// can mutate the mode in place without reallocating this PDA. The
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
    /// validate the mint's TransferHook extension authority here — Plan C
    /// Task 3 (cPOOL) and Task 5 (dePOOL) own that wiring and call this
    /// instruction as a CPI from `initialize_pool` / wrapper init. The
    /// `mint_authority` signer below provides the access-control gate.
    pub mint: UncheckedAccount<'info>,

    /// Per-mint configuration; mode is read directly via the typed
    /// `Account<'info, MintConfig>` wrapper, which Anchor validates
    /// against the canonical seeds before this handler runs. This is the
    /// preferred fix for the V1.C audit `read_mint_config_mode` stub —
    /// the mode is now read from a deserialized account rather than an
    /// unsafe raw byte read.
    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint.key().as_ref()],
        bump,
        seeds::program = crate::ID,
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// Mint authority — must sign so a stranger can't init another mint's
    /// extra-account-meta-list. Plan A does not yet validate that this
    /// matches `Mint::transfer_hook_authority`; the cross-plan invariant
    /// (Plan C Task 3 / Task 5) enforces it at the binding site.
    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeExtraAccountMetaList>) -> Result<()> {
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
        // source_attestation: SVS-11 Attestation PDA at
        // [b"attestation", source_owner].
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
        // destination_attestation: same shape, dest owner.
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
        // CRITICAL (V1.A audit fix): `account_index` MUST be 4, NOT 5.
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
