use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("8zf7pTE29kmMHoGJCbKP6QRre9RPEPboPad7X3dGutsH");

#[program]
pub mod derwa_wrapper {
    use super::*;

    /// Bind a pool to its (cPOOL, dePOOL) mint pair. One-shot per pool —
    /// Anchor's `init` constraint on `wrapper_config` prevents re-init.
    pub fn initialize(ctx: Context<InitializeWrapper>) -> Result<()> {
        instructions::initialize::handler(ctx)
    }

    /// Wrap permissioned cPOOL → freely-transferable dePOOL at 1:1.
    /// Investor transfers cPOOL into wrapper-PDA-owned ATA; wrapper mints
    /// dePOOL to investor. `locked_supply` increments to enforce the
    /// invariant `locked_supply == dePOOL.supply`.
    pub fn wrap(ctx: Context<Wrap>, amount: u64) -> Result<()> {
        instructions::wrap::handler(ctx, amount)
    }
}
