use anchor_lang::prelude::*;

/// Global sanctions list (one per program deployment).
/// Authority is the Ops Guardian Squads vault per P0.10 spec.
///
/// Address space: capped at 1024 sanctioned wallets initially. Realloc
/// extends capacity in 256-entry chunks if needed (P1+ concern).
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
    pub const MAX_ADDRESSES: usize = 1024;
    pub const SEED_PREFIX: &'static [u8] = b"sanctions_list";

    /// Account size budget for `init` allocation.
    /// 8 (discriminator) + 32 (authority) + 8 (version) + 8 (updated_at)
    /// + 4 (Vec length prefix) + 32 * MAX_ADDRESSES (data)
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 4 + (32 * Self::MAX_ADDRESSES);

    pub fn contains(&self, addr: &Pubkey) -> bool {
        self.addresses.contains(addr)
    }
}
