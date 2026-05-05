use anchor_lang::prelude::*;

/// Global sanctions list (one per program deployment).
/// Authority is held by the Ops Guardian Squads multisig vault.
///
/// Address space: capped at 256 sanctioned wallets at init. Realloc
/// extends capacity in 256-entry chunks if needed (future concern). The
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

/// Mode discriminator stored at mint-config-PDA level.
///
/// `FreelyTransferable` is fully implemented. `Permissioned` is wired in;
/// its attestation-checking branch is filled in by the per-mint config
/// flow. Today the `Permissioned` arm returns a placeholder error so the
/// mode is callable but not yet routable.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ComplianceMode {
    FreelyTransferable,
    Permissioned,
}

/// Mint config PDA — bound to a specific Token-2022 mint that uses this hook.
///
/// Seeds: `[b"mint_config", mint_pubkey]`
///
/// Layout (post-discriminator):
/// - `mint`         : `Pubkey` (32 bytes)              offset  8..40
/// - `mode`         : `ComplianceMode` (1 byte)         offset 40..41
/// - `pool_policy`  : `Option<Pubkey>` (1 + up to 32)   offset 41..74
///
/// `pool_policy` reserves the 33-byte max-case so layout is fixed-size;
/// the `Option<Pubkey>` byte at offset 41 is the discriminator
/// (0 = None, 1 = Some). `pool_policy` lives at byte offset
/// `8 + 34 = 42` inside the account; the ExtraAccountMetaList builder
/// consumes that offset.
#[account]
pub struct MintConfig {
    pub mint: Pubkey,
    pub mode: ComplianceMode,
    /// Optional pool policy PDA (Permissioned mode); unused in FreelyTransferable.
    pub pool_policy: Option<Pubkey>,
}

impl MintConfig {
    pub const SEED_PREFIX: &'static [u8] = b"mint_config";
    /// 8 (discriminator) + 32 (mint) + 1 (mode) + 1 (Option tag) + 32 (Pubkey)
    /// = 74 bytes (max-case `Option<Pubkey>` reserves all 33 fixed bytes).
    pub const SPACE: usize = 8 + 32 + 1 + 1 + 32;
}
