use anchor_lang::prelude::*;

pub mod error;
pub mod state;

pub use error::*;
pub use state::*;

declare_id!("7564bvScA3FjQ9w5nCx44EK4JkgitzZ3UstX1e4eKks7");

#[program]
pub mod nav_oracle {
    use super::*;
    // Instructions added in Tasks 3-5.
}
