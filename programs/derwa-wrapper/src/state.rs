use anchor_lang::prelude::*;

/// Per-pool wrapper config. One PDA per pool, seeded by the pool's CreditVault PDA.
///
/// Binds together the cPOOL (Permissioned) mint and the dePOOL (FreelyTransferable)
/// mint for a single pool, and tracks the cPOOL locked inside the wrapper PDA so
/// the 1:1 invariant (`locked_supply == dePOOL.supply`) can be checked on-chain.
#[account]
pub struct WrapperConfig {
    /// Pool this wrapper is for.
    pub pool: Pubkey,

    /// Token-2022 mint for permissioned cPOOL (compliance hook in Permissioned mode).
    pub permissioned_mint: Pubkey,

    /// Token-2022 mint for freely-transferable dePOOL (compliance hook in FreelyTransferable mode).
    pub derwa_mint: Pubkey,

    /// Total cPOOL currently locked in the wrapper PDA. Increments on wrap, decrements on unwrap.
    /// Must equal total dePOOL supply at all times (1:1 invariant).
    pub locked_supply: u64,

    pub bump: u8,
}

impl WrapperConfig {
    pub const SEED_PREFIX: &'static [u8] = b"wrapper_config";

    /// Account size budget for `init` allocation:
    /// 8 (discriminator) + 32 (pool) + 32 (permissioned_mint) + 32 (derwa_mint)
    /// + 8 (locked_supply) + 1 (bump) = 113 bytes.
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 1;
}
