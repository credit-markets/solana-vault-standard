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
