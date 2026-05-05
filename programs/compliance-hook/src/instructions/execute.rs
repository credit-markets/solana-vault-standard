use anchor_lang::prelude::*;
use spl_transfer_hook_interface::error::TransferHookError;

use crate::error::ComplianceHookError;
use crate::state::{ComplianceMode, MintConfig, SanctionsList};

/// `Execute` accounts: order MUST match the canonical Token-2022 TransferHook
/// layout — `source_ata`, `mint`, `destination_ata`, `source_owner` — followed
/// by the compliance-hook extras. The extra-account-meta-list (built in
/// `initialize_extra_account_meta_list`) derives the extra account seeds via
/// `Seed::AccountKey { index: N }` against these positions, so the order here
/// is load-bearing.
///
/// Permissioned-mode extras (`source_attestation`, `destination_attestation`,
/// `pool_policy`) are declared as `Option<UncheckedAccount>` so a single
/// `Execute` struct serves both modes. The Token-2022 runtime resolves the
/// EAML at the canonical seed (`b"extra-account-metas"`), and that PDA holds
/// 4 entries for `FreelyTransferable` and 7 for `Permissioned`.
/// Anchor 0.31's `Option<T>` account binding accepts a missing tail of
/// accounts as `None`, which matches the runtime's truncated invocation in
/// `FreelyTransferable` mode. The handler branches on `mint_config.mode` and
/// only touches the `Some` arms when `Permissioned`.
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

    /// CHECK: SVS-11 Attestation PDA for the source-ATA owner. Required only
    /// when `mint_config.mode == Permissioned`; the EAML omits this entry in
    /// `FreelyTransferable` mode, so the runtime passes `None`. The handler
    /// requires `Some` only on the Permissioned branch.
    /// Index 8 (Permissioned only).
    pub source_attestation: Option<UncheckedAccount<'info>>,

    /// CHECK: SVS-11 Attestation PDA for the destination-ATA owner. Same
    /// semantics as `source_attestation`.
    /// Index 9 (Permissioned only).
    pub destination_attestation: Option<UncheckedAccount<'info>>,

    /// CHECK: pool-policy PDA referenced by `mint_config.pool_policy`. The
    /// current implementation does NOT enforce any threshold (jurisdiction /
    /// investor_class / kyc_risk_tier) against this account — the
    /// Permissioned arm only validates that both attestations exist + are
    /// valid. The pool-policy extra is wired through the EAML for forward
    /// compatibility with a future enforcement layer that will consume it.
    /// The handler currently leaves this account untouched.
    /// Index 10 (Permissioned only).
    pub pool_policy: Option<UncheckedAccount<'info>>,
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
            // Token-2022 runtime resolves the EAML's 7 Permissioned extras and
            // populates the three `Option<>` fields below. A `None` here means
            // the EAML was misconfigured (wrong account count for the mode) —
            // surface that as `AttestationNotFound` (6002) so the on-chain emit
            // matches both the test scaffold expectations and the Helius
            // webhook parser, which keys on the 6000-series ComplianceHookError
            // codes. (`TransferHookError::IncorrectAccount` is in a different
            // namespace and would not classify correctly downstream.)
            let src_att = ctx
                .accounts
                .source_attestation
                .as_ref()
                .ok_or(ComplianceHookError::AttestationNotFound)?;
            let dst_att = ctx
                .accounts
                .destination_attestation
                .as_ref()
                .ok_or(ComplianceHookError::AttestationNotFound)?;

            check_attestation(&src_att.to_account_info(), "source")?;
            check_attestation(&dst_att.to_account_info(), "destination")?;

            // Future enforcement: pool_policy thresholds (jurisdiction /
            // investor_class / kyc_risk_tier) against the loaded attestations.
            // The current handler leaves `pool_policy` wired but unread — the
            // EAML still resolves it so a future upgrade can flip the
            // enforcement on without re-init.
            Ok(())
        }
    }
}

/// Reads an SVS-11 Attestation account (raw, without anchor zero-copy) and
/// validates it is present, non-revoked, and non-expired.
///
/// Layout is fixed by SVS-11's `Attestation` struct (see
/// `programs/svs-11/src/attestation.rs`). We rely on field offsets — DO NOT
/// desync this from svs-11 state without updating both sides. Current offset
/// map (after the 8-byte Anchor discriminator):
///   0..32    subject (Pubkey)
///   32..64   issuer (Pubkey)
///   64       attestation_type (u8)
///   65..67   country_code ([u8; 2])
///   67..75   issued_at (i64)
///   75..83   expires_at (i64)
///   83       revoked (bool, 1 byte)
///   84       bump (u8)
///   85..117  _reserved ([u8; 32])
///   117..119 jurisdiction ([u8; 2])
///   119      investor_class (u8)
///   120      kyc_risk_tier (u8)
/// Total: 121 bytes after discriminator (LEN = 8 + 121 = 129).
fn check_attestation(att: &AccountInfo, label: &'static str) -> Result<()> {
    require!(
        att.lamports() > 0 && att.data_len() > 0,
        ComplianceHookError::AttestationNotFound
    );

    let data = att.try_borrow_data()?;
    require!(data.len() >= 129, ComplianceHookError::AttestationNotFound);

    let payload = &data[8..];
    // `try_into().unwrap()` is sound here: the slice length is fixed by the
    // const-range above, and we've already bounds-checked `data.len() >= 129`
    // (= 8 disc + 121 payload), so `payload[75..83]` is always 8 bytes.
    let expires_at = i64::from_le_bytes(payload[75..83].try_into().unwrap()); // expires_at: i64
    let revoked = payload[83] != 0; // revoked: bool

    require!(!revoked, ComplianceHookError::AttestationRevoked);

    let now = Clock::get()?.unix_timestamp;
    require!(now < expires_at, ComplianceHookError::AttestationExpired);

    msg!("attestation OK ({})", label);
    Ok(())
}
