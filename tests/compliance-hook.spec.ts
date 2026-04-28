import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ComplianceHook } from "../target/types/compliance_hook";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("compliance-hook: update_sanctions_list", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ComplianceHook as Program<ComplianceHook>;

  const authority = Keypair.generate();
  const nonAuthority = Keypair.generate();
  let sanctionsListPda: PublicKey;

  before(async () => {
    [sanctionsListPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sanctions_list")],
      program.programId,
    );

    await provider.connection.requestAirdrop(authority.publicKey, 1e9);
    await provider.connection.requestAirdrop(nonAuthority.publicKey, 1e9);
    // wait for airdrop confirmation
    await new Promise((r) => setTimeout(r, 1500));

    await program.methods
      .initializeSanctionsList()
      .accounts({
        sanctionsList: sanctionsListPda,
        authority: authority.publicKey,
        payer: provider.wallet.publicKey,
      })
      .rpc();
  });

  it("authority can add an address", async () => {
    const sanctioned = Keypair.generate().publicKey;
    await program.methods
      .updateSanctionsList([sanctioned], [])
      .accounts({
        sanctionsList: sanctionsListPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const list = await program.account.sanctionsList.fetch(sanctionsListPda);
    expect(list.addresses.map((a) => a.toBase58())).to.include(
      sanctioned.toBase58(),
    );
    expect(list.version.toNumber()).to.equal(1);
  });

  it("non-authority is rejected", async () => {
    const sanctioned = Keypair.generate().publicKey;
    try {
      await program.methods
        .updateSanctionsList([sanctioned], [])
        .accounts({
          sanctionsList: sanctionsListPda,
          authority: nonAuthority.publicKey,
        })
        .signers([nonAuthority])
        .rpc();
      expect.fail("expected UnauthorizedAuthority");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("UnauthorizedAuthority");
    }
  });
});

describe("compliance-hook: execute (FreelyTransferable mode)", () => {
  // Full Token-2022 + transfer-hook test scaffolding (mint with extension,
  // ATAs, extra-account-meta-list) lands in Task 11. Until then these are
  // placeholders that document the intended coverage.

  it.skip("transfer between two non-sanctioned wallets succeeds", async () => {
    // Setup: invoke `execute` with sanctions_list, source ATA, destination
    // ATA, mint_config in FreelyTransferable mode, and frozen_check PDAs that
    // do NOT exist for either owner. Neither owner is on the sanctions list.
    // Expected: instruction returns Ok.
  });

  it.skip("transfer where destination owner is sanctioned fails", async () => {
    // Setup: add destination's wallet to sanctions list, then call execute.
    // Expected: SanctionedAddress (6000) error.
  });

  it.skip("transfer where source owner is sanctioned fails", async () => {
    // Mirror of the above for source owner.
    // Expected: SanctionedAddress (6000) error.
  });

  it.skip("transfer where source owner has FrozenAccount PDA fails", async () => {
    // Setup: create a FrozenAccount PDA at [b"frozen", source_owner].
    // Expected: AccountFrozen (6001) error.
  });

  it.skip("transfer where destination owner has FrozenAccount PDA fails", async () => {
    // Mirror for destination.
    // Expected: AccountFrozen (6001) error.
  });

});

describe("compliance-hook: execute (Permissioned mode)", () => {
  // Full Token-2022 + transfer-hook test scaffolding lands in Task 11. Until
  // then these are placeholders documenting the intended Permissioned-mode
  // coverage. Each case assumes:
  //   - a Token-2022 mint with TransferHook extension pointing at
  //     compliance-hook,
  //   - a `MintConfig` PDA with `mode = Permissioned`,
  //   - an `ExtraAccountMetaList` PDA initialized with the 7 Permissioned
  //     extras (Task 9b), and
  //   - SVS-11 Attestation PDAs (or the absence thereof) for the relevant
  //     wallets, with the offset map locked by Task 8.

  it.skip("transfer succeeds when both wallets have valid attestations", async () => {
    // Setup: source + destination owners each have an SVS-11 Attestation
    // PDA with `revoked = false` and `expires_at > now`. Sanctions list is
    // empty; no FrozenAccount PDAs.
    // Expected: instruction returns Ok and `attestation OK (...)` shows up
    // in the program logs twice.
  });

  it.skip("transfer fails when source attestation is missing", async () => {
    // Setup: destination has a valid attestation; source PDA does not exist
    // (lamports == 0, data_len == 0).
    // Expected: AttestationNotFound (6002) error.
  });

  it.skip("transfer fails when destination attestation is missing", async () => {
    // Mirror of the source-missing case for the destination wallet.
    // Expected: AttestationNotFound (6002) error.
  });

  it.skip("transfer fails when destination attestation is revoked", async () => {
    // Setup: destination Attestation written with `revoked = true` (byte 83
    // of payload after the 8-byte discriminator, per the layout locked in
    // Task 8). Source attestation is valid.
    // Expected: AttestationRevoked (6003) error.
  });

  it.skip("transfer fails when destination attestation is expired", async () => {
    // Setup: destination Attestation written with `expires_at` set to a
    // unix timestamp in the past (bytes 75..83 of payload, little-endian
    // i64). Source attestation is valid.
    // Expected: AttestationExpired (6004) error.
  });
});

describe("compliance-hook: initialize_extra_account_meta_list", () => {
  // Token-2022 TransferHook spec literal — note the HYPHEN, not underscore.
  // This is the seed the runtime looks up to resolve extra accounts when
  // executing a transfer through any mint bound to compliance-hook. Full
  // mint-with-extension scaffolding (init the mint, derive ATAs, etc.)
  // lands in Task 11; until then these are placeholders documenting intent.
  const EXTRA_ACCOUNT_METAS_SEED = "extra-account-metas";

  it.skip("creates the ExtraAccountMetaList PDA at the canonical seed", async () => {
    // Setup:
    //   - Create a Token-2022 mint with the TransferHook extension
    //     pointing at the compliance-hook program ID.
    //   - Create the per-mint MintConfig PDA at [b"mint_config", mint]
    //     with mode = FreelyTransferable.
    //   - Call initialize_extra_account_meta_list with that mint.
    // Expected:
    //   - PDA derived from [EXTRA_ACCOUNT_METAS_SEED, mint.toBuffer()]
    //     under compliance-hook program ID exists.
    //   - Account data deserializes via spl_tlv_account_resolution::state
    //     ::ExtraAccountMetaList.
    //   - List has 4 entries for FreelyTransferable mode (mint_config,
    //     sanctions_list, source_frozen_check, destination_frozen_check),
    //     or 7 for Permissioned (adds source_attestation,
    //     destination_attestation, pool_policy).
    void EXTRA_ACCOUNT_METAS_SEED;
  });

  it.skip("rejects re-initialization (already_in_use)", async () => {
    // Setup: invoke initialize_extra_account_meta_list twice on the same
    // mint without closing the PDA in between.
    // Expected: second call fails with the standard Anchor "account
    // already in use" / SystemProgram::CreateAccount-failure error.
  });

  it.skip("execute resolves all extra accounts via the PDA", async () => {
    // Setup: after initialize_extra_account_meta_list lands, perform a
    // real Token-2022 transfer through a hook-bound mint. The runtime
    // must resolve every entry in the PDA and pass them to execute in
    // the documented order.
    // Expected: transfer succeeds (assuming sanctions/frozen checks
    // pass).
  });
});
