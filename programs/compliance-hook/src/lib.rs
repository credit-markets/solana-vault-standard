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

    pub fn initialize_sanctions_list(ctx: Context<InitializeSanctionsList>) -> Result<()> {
        instructions::initialize_sanctions_list::handler(ctx)
    }
}
