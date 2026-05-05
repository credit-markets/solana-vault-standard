# derwa-wrapper

## Overview

The deRWA wrapper bridges between two Token-2022 mints owned by the same on-chain pool: the closed/permissioned mint (`cPOOL` — institutional shares with attestation-gated transfers) and an open Token-2022 mint (`dePOOL` — freely transferable with sanctions-only compliance hook gating). Wrapping is 1:1 in both directions. The wrapper is escrow-based for cPOOL (the wrapper PDA holds the locked supply in an ATA) and mint-based for dePOOL (a per-pool program-derived signer PDA, `wrapper_signer`, holds mint authority on dePOOL). The on-chain invariant `WrapperConfig.locked_supply == dePOOL.supply` is maintained on every wrap and unwrap.

The use case: an institutional investor holds cPOOL after KYC/KYB. To trade on a public DEX, they wrap cPOOL into dePOOL — cPOOL leaves their wallet into the wrapper escrow and dePOOL is minted to them. The dePOOL is freely transferable on DEXes. To unwrap back to cPOOL, the caller must present a valid (non-revoked, non-expired) attestation for the destination wallet — preventing arbitrary dePOOL holders (e.g. a non-attested DEX buyer) from acquiring permissioned cPOOL. cPOOL stays gated; dePOOL stays liquid.

## Architecture

```
   institutional   ┌─ wrap ──────────► dePOOL (open Token-2022 mint)
       wallet      │  cPOOL → escrow,      │
            cPOOL ─┤  mint dePOOL          │
                   │                       │
                   └─ unwrap ◄─────────────┘
                      burn dePOOL,
                      release cPOOL from escrow,
                      requires attestation
```

```
        ┌────────────────────────────────────┐
        │       WrapperConfig (per pool)     │
        │  pool, permissioned_mint,           │
        │  derwa_mint, locked_supply, bump   │
        └────────────────────────────────────┘
                          │
              ┌───────────┴────────────┐
              ▼                        ▼
    ┌──────────────────┐    ┌──────────────────┐
    │   cPOOL mint     │    │   dePOOL mint    │
    │ Permissioned hook│    │ FreelyTransfer.  │
    │ authority: SVS-11│    │ authority:       │
    │  vault PDA       │    │  wrapper_signer  │
    └──────────────────┘    └──────────────────┘
              ▲                        ▲
              │                        │
        ┌─────┴──────┐             ┌───┴───┐
        │ wrapper-PDA│             │ mint/ │
        │ owned ATA  │             │ burn  │
        │ (escrow of │             │ via   │
        │  locked_   │             │ PDA   │
        │  supply)   │             │ sign  │
        └────────────┘             └───────┘
              ▲                        ▲
              │                        │
              └─────── wrapper_signer ─┘
                  PDA: ["wrapper_signer", pool]
```

## Account Structures

### WrapperConfig (per-pool PDA)

113 bytes (8 disc + 105 data).

| Field | Type | Description |
|-------|------|-------------|
| pool | Pubkey | Pool this wrapper is bound to (SVS-11 CreditVault PDA) |
| permissioned_mint | Pubkey | Token-2022 cPOOL mint (Permissioned compliance hook) |
| derwa_mint | Pubkey | Token-2022 dePOOL mint (FreelyTransferable compliance hook) |
| locked_supply | u64 | cPOOL currently held in wrapper escrow. Invariant: equals dePOOL.supply |
| bump | u8 | PDA bump |

**Seeds:** `["wrapper_config", pool]`

### wrapper_signer (per-WrapperConfig PDA)

Program-derived signer that holds:
- **mint authority on dePOOL** (mints on wrap, burns on unwrap)
- **token authority on the wrapper escrow ATA** (the cPOOL ATA holding `locked_supply`)

Holds no on-chain data — pure authority. Seeds enforce uniqueness per pool.

**Seeds:** `["wrapper_signer", pool]`

## Instructions

### initialize

Binds a pool to its `(cPOOL, dePOOL)` mint pair by creating the per-pool `WrapperConfig`. Anchor's `init` constraint forbids re-init, locking the binding so an attacker cannot later re-point the wrapper at a different mint pair.

**Pre-conditions** (enforced outside this ix):
1. cPOOL mint exists with ComplianceHook in Permissioned mode (created by SVS-11 `initialize_pool`).
2. dePOOL mint exists with ComplianceHook in FreelyTransferable mode (created by `scripts/create-derwa-mint.ts`).
3. dePOOL mint authority is the `wrapper_signer` PDA (set during dePOOL creation).

**Accounts:** `pool` (pool PDA, unchecked), `wrapper_config` (init), `permissioned_mint`, `derwa_mint`, `payer`, `system_program`.

### wrap (cPOOL → dePOOL)

1:1 transfer of cPOOL into the wrapper PDA's ATA, then mint dePOOL to investor.

**Steps:**
1. `transfer_checked` cPOOL from `investor_permissioned_ata` → `wrapper_locked_ata` (signed by investor).
2. `mint_to` dePOOL to `investor_derwa_ata` (signed by `wrapper_signer` PDA).
3. `locked_supply += amount`.

**No attestation gate.** Anyone holding cPOOL has already passed KYB/KYC at the SVS-11 layer to acquire it; wrapping does not loosen access.

**Hook account caveat:** the cPOOL `transfer_checked` CPI invokes the Permissioned ComplianceHook, which on devnet is currently a no-op because MintConfig + ExtraAccountMetaList init is deferred. Once the hook is fully configured, the `Wrap` accounts struct will need to surface the hook's extra accounts via `remaining_accounts`. See the inline `HOOK ACCOUNT NOTE` in `wrap.rs`.

**Params:** `amount: u64`

**Errors:** `ZeroAmount`, `MintMismatch`.

### unwrap (dePOOL → cPOOL)

1:1 burn dePOOL, release cPOOL from the wrapper escrow back to the investor. **Attestation-gated with full identity binding.**

**Steps:**
1. Validate `investor_attestation` PDA via the FIVE-step trust-anchor check
   (`unwrap.rs::validate_investor_attestation`):
   - **Owner**: `att.owner == wrapper_config.attestation_program`.
   - **Subject**: `payload[0..32] == investor.key()` — atomically binds
     the attestation to THIS investor.
   - **Issuer**: `payload[32..64] == wrapper_config.attestation_issuer`.
   - **Type**: `payload[64] == wrapper_config.required_attestation_type`.
   - **Canonical PDA**: re-derives
     `[b"attestation", subject, issuer, attestation_type, bump]` under
     the configured attestation program and asserts it equals
     `att.key()`.

   Plus the existing `revoked == false` and `expires_at > now` checks.
2. `burn` dePOOL from `investor_derwa_ata` (signed by investor).
3. `transfer_checked` cPOOL from `wrapper_locked_ata` →
   `investor_permissioned_ata` (signed by `wrapper_signer` PDA). The
   Permissioned ComplianceHook on this transfer will ALSO enforce
   attestation once the EAML cross-program PDA wiring lands — until then
   the step-1 check is the sole gate. See "Iteration 2 follow-ups" in
   `compliance-hook.md`.
4. `locked_supply -= amount`.

**Why each layer matters:** cPOOL is permissioned. dePOOL is liquid —
anyone can buy it on a DEX. Without the FULL identity binding, a non-KYB
buyer could either:

- (a) Pass a STRANGER'S valid attestation (any KYC'd wallet's PDA) and
  unwrap into permissioned cPOOL. Pre-iteration-1 the unwrap handler
  did NOT read the `subject` field — this exact attack worked.
- (b) Pass a low-tier attestation against a vault that requires a
  higher tier (e.g. generic KYC vs accredited investor). The
  attestation_type check (4) prevents this.
- (c) Forge an attestation account in a different program. The owner
  check (1) prevents this.

The defense-in-depth `transfer_checked` hook step (3) catches any of
these if the explicit check is somehow bypassed (today: not possible
because the explicit check is on the same program), tomorrow: yes once
the hook is fully wired.

**Attestation layout** (must stay in sync with `compliance-hook::execute::check_attestation` and SVS-11's `Attestation` struct):

```
payload offsets (data[8..] after Anchor discriminator):
   0..32    subject (Pubkey)
  32..64    issuer (Pubkey)
  64        attestation_type (u8)
  65..67    country_code ([u8; 2])
  67..75    issued_at (i64)
  75..83    expires_at (i64)        ← read by unwrap
  83        revoked (bool)          ← read by unwrap
  84        bump (u8)
  85..117   _reserved
 117..119   jurisdiction
 119        investor_class (u8)
 120        kyc_risk_tier (u8)
```

**Params:** `amount: u64`

**Errors:** `ZeroAmount`, `InsufficientLockedSupply`, `AttestationRequired`, `MintMismatch`.

## Errors

| Code | Variant | Description |
|------|---------|-------------|
| 8000 | ZeroAmount | wrap/unwrap amount must be greater than zero |
| 8001 | AttestationRequired | unwrap requires a valid (non-revoked, non-expired) attestation on the destination wallet |
| 8002 | InsufficientLockedSupply | cannot unwrap more cPOOL than is currently locked |
| 8003 | MintMismatch | cPOOL or dePOOL mint passed does not match `WrapperConfig` binding |

## Security

- **Mint authority on dePOOL** is held by `wrapper_signer` PDA — only the wrapper program can mint or burn dePOOL.
- **Mint authority on cPOOL** stays with the SVS-11 vault authority. **The wrapper has NO authority over cPOOL** — it never mints cPOOL. Wrap moves cPOOL into the wrapper-owned escrow ATA; unwrap moves it back out. The total cPOOL supply is unchanged by wrap/unwrap operations.
- **Wrap is permissioned-by-construction.** Only existing cPOOL holders can wrap, and they already passed compliance to receive cPOOL.
- **Unwrap is attestation-gated.** Prevents arbitrary dePOOL holders (e.g. non-KYB DEX buyers) from acquiring cPOOL by routing through the wrapper.
- **Defence-in-depth on unwrap.** The explicit attestation check in the handler is redundant with the Permissioned ComplianceHook running on the cPOOL `transfer_checked`. The redundancy guards against a misconfigured/unset hook (current devnet state) — the explicit check still rejects unattested destinations even when the hook is a no-op.
- **Mint binding is locked.** `WrapperConfig` uses Anchor `init` (one-shot) plus mint constraints on every wrap/unwrap, so the `(pool, cPOOL, dePOOL)` triplet cannot be re-pointed after initialization.
- **1:1 ratio + escrow design.** No inflation surface — total cPOOL is conserved; dePOOL minted equals cPOOL escrowed. The on-chain invariant `locked_supply == dePOOL.supply` is maintained by the ix order (transfer/burn before mint/transfer-out, then update `locked_supply`).
- **Overflow on `locked_supply`.** `wrap` uses `checked_add(...).unwrap()` — a u64 overflow is practically impossible (would require 1.8e19 base units of real-world credit) and is treated as a fail-loud invariant violation.

## Integration with SVS-11

SVS-11 emits cPOOL as the `shares_mint` on share issuance. The wrapper reads it for wrap/unwrap, but never mints it.

**Authority split:**
- SVS-11 vault authority owns cPOOL **mint authority** (issues new shares).
- Wrapper `wrapper_signer` PDA owns dePOOL **mint authority** (mints on wrap, burns on unwrap).
- Wrapper `wrapper_signer` PDA owns the **wrapper escrow ATA** that holds locked cPOOL.

**Why escrow, not mint, for cPOOL:** the wrapper has no claim on cPOOL issuance — only the underlying credit pool can mint shares. By holding cPOOL in escrow during the dePOOL lifecycle, the wrapper preserves the property that cPOOL.supply on-chain reflects the actual share count, regardless of how much is wrapped.

## Integration with compliance-hook

The dePOOL mint typically uses `compliance-hook` in **FreelyTransferable** mode (sanctions / blocked-jurisdiction check only) so dePOOL stays liquid on DEXes without per-wallet attestation lookups. The cPOOL mint uses **Permissioned** mode (sanctions + valid attestation required for every transfer destination).

In `unwrap`, the cPOOL `transfer_checked` CPI runs through the Permissioned hook on the destination wallet. The wrapper handler also performs an explicit attestation check (offsets-based) before the CPI as defence-in-depth.

In `wrap`, the cPOOL `transfer_checked` CPI from investor → escrow runs through the Permissioned hook on the destination (the wrapper PDA's ATA owner). On devnet today the hook is a no-op due to deferred MintConfig; once active, the wrapper ATA's owner (the `wrapper_signer` PDA) must satisfy the hook — typically via an attestation issued to that PDA, or via a special FreelyTransferable rule for wrapper-PDA-bound transfers.

## Constants

None. The wrapper has no tunable parameters at the program level. All configuration is per-pool, recorded in `WrapperConfig` at `initialize`.

## Implementation Files

```
programs/derwa-wrapper/src/
├── lib.rs                          // program entrypoint, declare_id, 3 ixs
├── state.rs                        // WrapperConfig
├── error.rs                        // DeRwaError (8000-8003)
└── instructions/
    ├── mod.rs
    ├── initialize.rs               // bind (pool, cPOOL, dePOOL) into WrapperConfig
    ├── wrap.rs                     // cPOOL → escrow, mint dePOOL (1:1, no gate)
    └── unwrap.rs                   // burn dePOOL, escrow → cPOOL (1:1, attestation-gated)
```

## Iteration 2 follow-ups

### Wrap CPI remaining_accounts forwarding

The cPOOL `transfer_checked` CPI in `wrap.rs` does not currently forward
`remaining_accounts` to the Token-2022 TransferHook. Top-level user
transactions get auto-resolution from the runtime; CPIs do NOT. Once
the compliance-hook EAML cross-program PDA wiring lands (see
`compliance-hook.md::Iteration 2 follow-ups`), an active Permissioned-mode
hook on cPOOL would cause every wrap/unwrap CPI to fail with the hook's
"missing extras" error.

The fix: extend `Wrap` and `Unwrap` accounts structs to carry
`remaining_accounts: Vec<AccountInfo>` and forward them to the CPI via
`with_remaining_accounts()`. The set of extras must match the EAML the
Permissioned cPOOL mint declares — the SDK's wrapping/unwrapping
helpers should resolve this automatically (read EAML, derive extras,
pass through).

### Hook-side attestation for the wrapper PDA

`wrap`'s cPOOL transfer goes investor → `wrapper_signer` PDA's ATA.
The destination of that transfer is the wrapper PDA, which is NOT a
KYB'd wallet. With the current attestation-binding semantics, any wrap
would fail the Permissioned hook's destination-attestation check.

Two resolution paths considered:
1. Issue a "system" attestation to the `wrapper_signer` PDA in the same
   attestation program as the regular investor attestations. Cleanest,
   but couples wrapper deployment to the attestation issuer.
2. Add a "wrapper-PDA-bound transfers are FreelyTransferable" rule to
   compliance-hook's `execute` handler — recognized by checking
   `destination_owner == wrapper_signer_pda` against a list of
   wrapper-program-derived PDAs.

Iteration 2 will pick one based on the operator workflow.

## See Also

- [SVS-11.md](./SVS-11.md) — CreditVault (issues cPOOL, owns cPOOL mint authority)
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Cross-program design
- [SECURITY.md](./SECURITY.md) — Authority and attestation model
- [compliance-hook.md](./compliance-hook.md#iteration-2-follow-ups) — EAML and freeze ix follow-ups
