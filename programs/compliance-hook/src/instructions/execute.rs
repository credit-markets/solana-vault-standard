use anchor_lang::prelude::*;
use spl_transfer_hook_interface::error::TransferHookError;

use crate::error::ComplianceHookError;
use crate::state::{ComplianceMode, MintConfig, SanctionsList};

/// `Execute` accounts: order MUST match the canonical Token-2022 TransferHook
/// layout — `source_ata`, `mint`, `destination_ata`, `source_owner` — followed
/// by the compliance-hook extras. The extra-account-meta-list bound by Task 9b
/// derives the extra account seeds via `Seed::AccountKey { index: N }` against
/// these positions, so the order here is load-bearing.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: source ATA — owner read from offset 32..64 of account data.
    /// Index 0 in the canonical TransferHook layout.
    pub source_ata: UncheckedAccount<'info>,

    /// CHECK: mint that's being transferred (validated via mint_config seed).
    /// Index 1.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: destination ATA — owner read from offset 32..64.
    /// Index 2.
    pub destination_ata: UncheckedAccount<'info>,

    /// CHECK: source owner authority (also derivable from `source_ata`).
    /// Index 3.
    pub source_owner: UncheckedAccount<'info>,

    /// Per-mint configuration; mode discriminator drives the branch below.
    /// Index 4.
    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint.key().as_ref()],
        bump,
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// Global sanctions list (singleton PDA).
    /// Index 5.
    #[account(
        seeds = [SanctionsList::SEED_PREFIX],
        bump,
    )]
    pub sanctions_list: Account<'info, SanctionsList>,

    /// CHECK: optional `FrozenAccount` PDA for source. Existence indicates
    /// frozen; an absent PDA shows up here as a default-zero account.
    /// Index 6.
    pub source_frozen_check: UncheckedAccount<'info>,

    /// CHECK: optional `FrozenAccount` PDA for destination. Same semantics.
    /// Index 7.
    pub destination_frozen_check: UncheckedAccount<'info>,
    // Permissioned-mode adds: source_attestation, destination_attestation,
    // pool_policy. Wired in Task 10.
}

/// Read the owner pubkey from a Token-2022 ATA's raw account data.
///
/// Per the SPL Token-2022 account layout, bytes 32..64 hold the `owner`
/// pubkey. We deliberately don't try to deserialize the full TokenAccount
/// struct here — we only need the owner field, and reading raw bytes keeps
/// the hook resilient to extension-bearing accounts whose total size differs
/// from the base account size.
fn ata_owner(ata: &AccountInfo) -> Result<Pubkey> {
    let data = ata.try_borrow_data()?;
    if data.len() < 64 {
        // The interface's `IncorrectAccountSize` variant doesn't exist in the
        // 0.9 release; the closest semantic match is `IncorrectAccount`.
        // Conversion goes through `ProgramError` because Anchor's `Error`
        // implements `From<ProgramError>` but not `From<TransferHookError>`
        // directly.
        return Err(ProgramError::from(TransferHookError::IncorrectAccount).into());
    }
    Ok(Pubkey::try_from(&data[32..64])
        .map_err(|_| -> Error { ProgramError::from(TransferHookError::IncorrectAccount).into() })?)
}

pub fn handler(ctx: Context<Execute>) -> Result<()> {
    let source_owner = ata_owner(&ctx.accounts.source_ata)?;
    let dest_owner = ata_owner(&ctx.accounts.destination_ata)?;

    let sl = &ctx.accounts.sanctions_list;
    require!(
        !sl.contains(&source_owner) && !sl.contains(&dest_owner),
        ComplianceHookError::SanctionedAddress
    );

    // Frozen check: PDA existence — non-zero lamports + non-empty data —
    // marks the account as frozen. The runtime will pass the derived PDA
    // address even when the account doesn't exist; in that case lamports == 0
    // and data.len() == 0, so the booleans below stay false.
    let src_frozen = ctx.accounts.source_frozen_check.lamports() > 0
        && ctx.accounts.source_frozen_check.data_len() > 0;
    let dst_frozen = ctx.accounts.destination_frozen_check.lamports() > 0
        && ctx.accounts.destination_frozen_check.data_len() > 0;
    require!(!src_frozen && !dst_frozen, ComplianceHookError::AccountFrozen);

    match ctx.accounts.mint_config.mode {
        ComplianceMode::FreelyTransferable => Ok(()),
        ComplianceMode::Permissioned => {
            // Permissioned check (attestation reads + pool policy) lands in
            // Task 10. Until then, return the interface's "outside transfer"
            // sentinel so the mode is wired but rejects every call.
            // Bridge through `ProgramError` (see note in `ata_owner`).
            Err(ProgramError::from(TransferHookError::ProgramCalledOutsideOfTransfer).into())
        }
    }
}
