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
}
