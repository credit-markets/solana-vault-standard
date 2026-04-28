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

  it.skip("Permissioned-mode mint rejects until Task 10 lands", async () => {
    // Setup: MintConfig with mode = Permissioned.
    // Expected: TransferHookError::ProgramCalledOutsideOfTransfer (placeholder
    // until attestation logic is wired).
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
