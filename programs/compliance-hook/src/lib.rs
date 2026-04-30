use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("6JKauKWVJqs9duaCqXCMS6UN9KvqHxMjLS5KwJxGqH5P");

#[program]
pub mod compliance_hook {
    use super::*;

    /// Initialize the global `SanctionsList` PDA. Called once per
    /// program deployment; the `authority` set here gates all future
    /// updates. Production: rotated to the Ops Guardian Squads vault.
    pub fn initialize_sanctions_list(ctx: Context<InitializeSanctionsList>) -> Result<()> {
        instructions::initialize_sanctions_list::handler(ctx)
    }

    /// Initialize the per-mint `ExtraAccountMetaList` PDA at
    /// `[b"extra-account-metas", mint]` — the Token-2022 TransferHook
    /// spec requires this PDA so the runtime can resolve the extra
    /// accounts `execute` consumes beyond the canonical 4. Sized for
    /// `Permissioned` mode (7 extras) so a future mode switch does not
    /// require realloc.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        instructions::initialize_extra_account_meta_list::handler(ctx)
    }

    /// Authority-gated mutation of the sanctions list. Applies `removals`
    /// first, then `additions` (skipping already-present entries), bumps
    /// the version counter, and emits `SanctionsListUpdated`.
    pub fn update_sanctions_list(
        ctx: Context<UpdateSanctionsList>,
        additions: Vec<Pubkey>,
        removals: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::update_sanctions_list::handler(ctx, additions, removals)
    }

    /// Token-2022 TransferHook entry point. Verifies that neither the source
    /// nor destination ATA owner is on the sanctions list and that no
    /// `FrozenAccount` PDA exists for either, then branches on the mint's
    /// `ComplianceMode`. `FreelyTransferable` returns `Ok`; `Permissioned`
    /// validates that BOTH source and destination wallets hold non-revoked,
    /// non-expired SVS-11 Attestation PDAs (Task 10). Pool-policy threshold
    /// enforcement (jurisdiction / investor_class / kyc_risk_tier) is
    /// reserved for P1.
    pub fn execute(ctx: Context<Execute>) -> Result<()> {
        instructions::execute::handler(ctx)
    }
}
