use anchor_lang::prelude::*;

pub const VAULT_SEED: &[u8] = b"credit_vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";
pub const REDEMPTION_ESCROW_SEED: &[u8] = b"redemption_escrow";
pub const INVESTMENT_REQUEST_SEED: &[u8] = b"investment_request";
pub const REDEMPTION_REQUEST_SEED: &[u8] = b"redemption_request";
pub const CLAIMABLE_TOKENS_SEED: &[u8] = b"claimable_tokens";
pub const FROZEN_ACCOUNT_SEED: &[u8] = b"frozen_account";
pub const VAULT_CONFIG_SEED: &[u8] = b"vault_config";

/// Seed for the per-pool NavAccount PDA in the nav-oracle program (Plan B).
/// Mirrors `nav_oracle::state::NavAccount::SEED_PREFIX`. Hard-coded here so
/// SVS-11 does not depend on the nav-oracle crate at compile time.
pub const NAV_ORACLE_SEED: &[u8] = b"nav_oracle";

pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;
pub const DEFAULT_MAX_DEVIATION_BPS: u16 = 500;
pub const MAX_DEVIATION_BPS_CAP: u16 = 2000;
pub const ORACLE_TIMELOCK: i64 = 86400; // 24 hours

/// Default per-pool maximum NAV staleness (45 days = 3,888,000 sec).
/// Plan B Task 6 / audit P0.C: written to CreditVault.max_nav_staleness_secs
/// at initialize_pool time; admin can update via update_oracle_params later.
pub const DEFAULT_MAX_NAV_STALENESS_SECS: i64 = 3_888_000;

/// On-chain Program ID for the nav-oracle program (Plan B Task 1).
/// Used by SVS-11 to derive + validate the NavAccount PDA in approve_deposit
/// and approve_redeem when CreditVault.oracle_source == 1. Kept in sync with
/// `programs/nav-oracle/src/lib.rs::declare_id!`.
pub const NAV_ORACLE_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("7564bvScA3FjQ9w5nCx44EK4JkgitzZ3UstX1e4eKks7");

/// CreditVault.oracle_source values (P0.G emergency-revert toggle).
pub const ORACLE_SOURCE_MOCK: u8 = 0; // legacy mock_oracle path
pub const ORACLE_SOURCE_NAV_ORACLE: u8 = 1; // Plan B canonical path
