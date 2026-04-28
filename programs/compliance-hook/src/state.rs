use anchor_lang::prelude::*;

/// Global sanctions list (one per program deployment).
/// Authority is the Ops Guardian Squads vault per P0.10 spec.
///
/// Address space: capped at 256 sanctioned wallets at init. Realloc
/// extends capacity in 256-entry chunks if needed (P1+ concern). The
/// 256 cap keeps `SPACE` under Solana's 10_240-byte CPI allocation
/// limit (`MAX_PERMITTED_DATA_INCREASE`) so `init` succeeds in one CPI.
#[account]
pub struct SanctionsList {
    /// Squads multisig PDA controlling updates.
    pub authority: Pubkey,

    /// Increments on every successful update; consumers can detect changes.
    pub version: u64,

    /// Unix-timestamp seconds; set by program at update time.
    pub updated_at: i64,

    /// Sanctioned addresses. Bounded by `MAX_ADDRESSES` (init capacity).
    pub addresses: Vec<Pubkey>,
}

impl SanctionsList {
    pub const MAX_ADDRESSES: usize = 256;
    pub const SEED_PREFIX: &'static [u8] = b"sanctions_list";

    /// Account size budget for `init` allocation:
    /// 8 (discriminator) + 32 (authority) + 8 (version) + 8 (updated_at)
    /// plus 4 (Vec length prefix) + 32 * MAX_ADDRESSES (data) =
    /// 60 + 8192 = 8252 bytes (under the 10_240 CPI realloc cap).
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 4 + (32 * Self::MAX_ADDRESSES);

    pub fn contains(&self, addr: &Pubkey) -> bool {
        self.addresses.contains(addr)
    }
}

// Re-export `MintConfig` + `ComplianceMode` from the instruction module so
// downstream code can `use crate::state::MintConfig` regardless of where the
// struct is physically defined. Per audit V1.C, the canonical home for the
// type is alongside `Execute` (since the layout and accounts struct are
// co-evolving), but the rest of the program (and Task 9b's
// `init_extra_account_meta_list`) imports it from `state`.
pub use crate::instructions::execute::{ComplianceMode, MintConfig};
