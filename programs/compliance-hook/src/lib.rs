use anchor_lang::prelude::*;

pub mod error;
pub mod state;

pub use error::*;
pub use state::*;

declare_id!("6JKauKWVJqs9duaCqXCMS6UN9KvqHxMjLS5KwJxGqH5P");

#[program]
pub mod compliance_hook {
    use super::*;
    // Instructions land here in subsequent tasks.
}
