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
