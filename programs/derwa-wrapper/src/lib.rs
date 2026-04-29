use anchor_lang::prelude::*;

pub mod error;
pub mod state;

pub use error::*;
pub use state::*;

declare_id!("8zf7pTE29kmMHoGJCbKP6QRre9RPEPboPad7X3dGutsH");

#[program]
pub mod derwa_wrapper {
    use super::*;
}
