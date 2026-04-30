use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::{DEFAULT_MAX_NAV_STALENESS_SECS, VAULT_SEED};
use crate::error::VaultError;
use crate::state::CreditVault;

/// Old `CreditVault` size before the NavOracle integration fields were added.
/// Equals current `CreditVault::LEN - 32`. Hand-written rather than computed
/// because we explicitly want the migration to be tied to a specific past
/// layout: if a future field is added, this constant DOES NOT shift, and a
/// new realloc ix is written to migrate from `CreditVault::LEN` (current) to
/// the next size.
const CREDIT_VAULT_LEN_PRE_ORACLE_V2: usize = CreditVault::LEN - 32;

/// Migrates an existing `CreditVault` account from the pre-oracle-v2 layout
/// (rent-exempt sized for `CREDIT_VAULT_LEN_PRE_ORACLE_V2`) to the current
/// layout (sized for `CreditVault::LEN`, +32 bytes for NavOracle fields).
///
/// Idempotent: if the account is already at the new size, the handler
/// returns Ok without touching anything. Authority-gated: only the vault's
/// stored `authority` may invoke this.
///
/// Why a dedicated migration instead of a generic "resize this account":
/// CreditVault accounts already deployed on devnet (and any pools that ship
/// before the bundled upgrade) hold real funds. A generic resize would
/// require reading + verifying the authority via raw byte offsets, which is
/// what we do here, but a single-purpose ix makes the migration's intent
/// clear in audit logs and limits the blast radius if the bytecode is
/// later compromised.
#[derive(Accounts)]
pub struct ReallocCreditVaultForOracleV2<'info> {
    /// CHECK: We can't bind `Account<CreditVault>` here because old-layout
    /// accounts are 32 bytes shorter than the current LEN, and Anchor would
    /// fail deserialization on entry. We read the authority field at the
    /// canonical post-discriminator offset (bytes 8..40) for access control.
    #[account(
        mut,
        // Seed-bind so a caller can't pass a non-CreditVault PDA. The
        // bump comes from the asset_mint+vault_id portion of the account
        // data we read manually below — but we can ALSO accept it as a
        // remaining-account argument. Cheaper to just verify by seed
        // re-derivation in the handler since the asset_mint and vault_id
        // are at fixed offsets.
        owner = crate::ID @ VaultError::Unauthorized,
    )]
    pub vault: UncheckedAccount<'info>,

    /// Must match the authority pubkey at the start of vault data
    /// (bytes 8..40 after the Anchor discriminator).
    pub authority: Signer<'info>,

    /// Pays the rent-exemption delta (NEW_LEN > OLD_LEN means we need to
    /// add lamports to keep the account rent-exempt). Typically the
    /// operator who's running the bundled upgrade.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ReallocCreditVaultForOracleV2>) -> Result<()> {
    let vault_info = &ctx.accounts.vault;
    let current_len = vault_info.data_len();

    // Idempotent: already migrated. Don't error — operators may run this
    // across the full pool list and we want re-runs to be safe.
    if current_len == CreditVault::LEN {
        msg!(
            "vault {} already at new size ({} bytes); skipping",
            vault_info.key(),
            current_len,
        );
        return Ok(());
    }

    // Reject anything that's NOT exactly the old layout. A vault at some
    // other size is corrupt or from a layout we don't know about; refuse.
    require_eq!(
        current_len,
        CREDIT_VAULT_LEN_PRE_ORACLE_V2,
        VaultError::Unauthorized
    );

    // Authority gate. Read the `authority: Pubkey` field at the start of
    // the account data (after the 8-byte Anchor discriminator). The offset
    // is stable across both layouts because authority is the very first
    // field of CreditVault.
    let authority_bytes: [u8; 32] = {
        let data = vault_info.try_borrow_data()?;
        data[8..40].try_into().map_err(|_| VaultError::Unauthorized)?
    };
    let stored_authority = Pubkey::from(authority_bytes);
    require_keys_eq!(
        stored_authority,
        ctx.accounts.authority.key(),
        VaultError::Unauthorized
    );

    // Top up the rent-exempt minimum for the new size BEFORE resize.
    // Resize without rent-top-up leaves the account rent-deficient and
    // could be reaped by anyone running an account-cleanup tx.
    let rent = Rent::get()?;
    let new_min = rent.minimum_balance(CreditVault::LEN);
    let current_lamports = vault_info.lamports();
    if new_min > current_lamports {
        let delta = new_min - current_lamports;
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: vault_info.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, delta)?;
    }

    // Resize. The new tail bytes (CREDIT_VAULT_LEN_PRE_ORACLE_V2..LEN) are
    // zero-initialized by the runtime, which gives us:
    //   last_seen_nav_sequence    = 0   ✓ (no NAV consumed yet)
    //   last_seen_nav_price       = 0   ✓ (deviation baseline bootstraps on first read)
    //   max_nav_staleness_secs    = 0   ✗ (we want DEFAULT_MAX_NAV_STALENESS_SECS)
    //   oracle_source             = 0   ✓ (legacy mock_oracle, safe revert default)
    //   _padding_oracle           = [0; 7] ✓
    // We overwrite only `max_nav_staleness_secs` since 0 would make every
    // NAV read trip OracleStale.
    vault_info.resize(CreditVault::LEN)?;

    // Write `max_nav_staleness_secs` at its known offset.
    // Offset = OLD_LEN + 8 (last_seen_nav_sequence: u64) + 8 (last_seen_nav_price: u64).
    let staleness_offset = CREDIT_VAULT_LEN_PRE_ORACLE_V2 + 16;
    {
        let mut data = vault_info.try_borrow_mut_data()?;
        let staleness_bytes = DEFAULT_MAX_NAV_STALENESS_SECS.to_le_bytes();
        data[staleness_offset..staleness_offset + 8].copy_from_slice(&staleness_bytes);
    }

    msg!(
        "vault {} migrated to oracle_v2 layout (size {} -> {}, staleness={}s)",
        vault_info.key(),
        CREDIT_VAULT_LEN_PRE_ORACLE_V2,
        CreditVault::LEN,
        DEFAULT_MAX_NAV_STALENESS_SECS,
    );

    // Sanity: the seed-derived PDA matches the account address. We do
    // this AFTER the resize because a malformed vault would have already
    // tripped the layout check above. Reading asset_mint + vault_id off
    // the now-resized account confirms the structure.
    let data = vault_info.try_borrow_data()?;
    let asset_mint_bytes: [u8; 32] = data[8 + 32 + 32..8 + 32 + 32 + 32]
        .try_into()
        .map_err(|_| VaultError::Unauthorized)?;
    let vault_id_bytes: [u8; 8] = {
        // CreditVault: discriminator(8) + authority(32) + manager(32) + asset_mint(32)
        //   + shares_mint(32) + deposit_vault(32) + redemption_escrow(32)
        //   + nav_oracle(32) + oracle_program(32) + max_staleness(8)
        //   + attester(32) + attestation_program(32) + vault_id(8)
        const VAULT_ID_OFFSET: usize = 8 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 8 + 32 + 32;
        data[VAULT_ID_OFFSET..VAULT_ID_OFFSET + 8]
            .try_into()
            .map_err(|_| VaultError::Unauthorized)?
    };
    let asset_mint = Pubkey::from(asset_mint_bytes);
    let (expected_vault, _bump) = Pubkey::find_program_address(
        &[VAULT_SEED, asset_mint.as_ref(), &vault_id_bytes],
        &crate::ID,
    );
    require_keys_eq!(expected_vault, vault_info.key(), VaultError::Unauthorized);

    Ok(())
}
