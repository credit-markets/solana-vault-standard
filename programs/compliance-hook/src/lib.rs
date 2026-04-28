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

    /// Initialize the global `SanctionsList` PDA. Called once per program
    /// deployment; the `authority` set here gates all future updates and
    /// will be the Ops Guardian Squads vault per Plan A Task 14.
    pub fn initialize_sanctions_list(ctx: Context<InitializeSanctionsList>) -> Result<()> {
        instructions::initialize_sanctions_list::handler(ctx)
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
}
