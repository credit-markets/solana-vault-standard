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

    pub fn initialize(ctx: Context<InitializeNavAccount>, args: InitializeNavArgs) -> Result<()> {
        instructions::initialize::handler(ctx, args)
    }

    pub fn update(ctx: Context<UpdateNav>, args: UpdateArgs) -> Result<()> {
        instructions::update::handler(ctx, args)
    }

    pub fn rotate_publisher(ctx: Context<RotatePublisher>) -> Result<()> {
        instructions::rotate_publisher::handler(ctx)
    }
}
