use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("7564bvScA3FjQ9w5nCx44EK4JkgitzZ3UstX1e4eKks7");

#[program]
pub mod nav_oracle {
    use super::*;

    /// Initialize the per-pool `NavAccount` PDA at `[b"nav_oracle", pool]`.
    /// Sets the publisher key + key_rotation_authority (Protocol Guardian
    /// Squads vault). Initial NAV fields zeroed; first `update` call sets
    /// real values.
    pub fn initialize(ctx: Context<InitializeNavAccount>) -> Result<()> {
        instructions::initialize::handler(ctx)
    }
}
