import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { NavOracle } from "../target/types/nav_oracle";
import {
  Keypair,
  PublicKey,
  Ed25519Program,
  Transaction,
} from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { expect } from "chai";

describe("nav-oracle: update", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.NavOracle as Program<NavOracle>;

  const publisher = Keypair.generate();
  const rotationAuthority = Keypair.generate(); // stand-in for Protocol Guardian
  const pool = Keypair.generate(); // stand-in for SVS-11 CreditVault PDA
  let navPda: PublicKey;

  before(async () => {
    [navPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nav_oracle"), pool.publicKey.toBuffer()],
      program.programId,
    );

    await program.methods
      .initialize()
      .accounts({
        pool: pool.publicKey,
        navAccount: navPda,
        publisher: publisher.publicKey,
        keyRotationAuthority: rotationAuthority.publicKey,
        payer: provider.wallet.publicKey,
      })
      .rpc();
  });

  function buildSigningPayload(fields: {
    pool: PublicKey;
    navNet: bigint;
    navGross: bigint;
    terBps: number;
    lossBps: number;
    navType: number;
    timestamp: bigint;
    sequence: bigint;
    publisher: PublicKey;
    merkleRoot: Buffer;
  }): Buffer {
    // P1.B fix: signing payload is 133 bytes (32+8+8+2+2+1+8+8+32+32). Earlier draft
    // mis-sized at 110, which silently truncated the merkleRoot field (last 32 bytes
    // landed past the buffer end) and made every signature mismatch in tests.
    // Math: pool(32) + navNet(8) + navGross(8) + terBps(2) + lossBps(2) + navType(1)
    //     + timestamp(8) + sequence(8) + publisher(32) + merkleRoot(32) = 133
    const buf = Buffer.alloc(133);
    let off = 0;
    fields.pool.toBuffer().copy(buf, off);
    off += 32;
    buf.writeBigUInt64LE(fields.navNet, off);
    off += 8;
    buf.writeBigUInt64LE(fields.navGross, off);
    off += 8;
    buf.writeUInt16LE(fields.terBps, off);
    off += 2;
    buf.writeUInt16LE(fields.lossBps, off);
    off += 2;
    buf.writeUInt8(fields.navType, off);
    off += 1;
    buf.writeBigInt64LE(fields.timestamp, off);
    off += 8;
    buf.writeBigUInt64LE(fields.sequence, off);
    off += 8;
    fields.publisher.toBuffer().copy(buf, off);
    off += 32;
    fields.merkleRoot.copy(buf, off);
    off += 32;
    return buf.subarray(0, off);
  }

  async function buildAndSendUpdate(args: {
    navNet: bigint;
    navGross: bigint;
    terBps: number;
    lossBps: number;
    navType: number;
    timestamp: bigint;
    sequence: bigint;
    merkleRoot: Buffer;
  }) {
    const fields = {
      pool: pool.publicKey,
      navNet: args.navNet,
      navGross: args.navGross,
      terBps: args.terBps,
      lossBps: args.lossBps,
      navType: args.navType,
      timestamp: args.timestamp,
      sequence: args.sequence,
      publisher: publisher.publicKey,
      merkleRoot: args.merkleRoot,
    };
    const payload = buildSigningPayload(fields);
    const signature = nacl.sign.detached(payload, publisher.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: publisher.publicKey.toBytes(),
      message: payload,
      signature,
    });
    const updateIx = await program.methods
      .update({
        navNet: new anchor.BN(args.navNet.toString()),
        navGross: new anchor.BN(args.navGross.toString()),
        terBps: args.terBps,
        lossBps: args.lossBps,
        navType: args.navType,
        timestamp: new anchor.BN(args.timestamp.toString()),
        sequence: new anchor.BN(args.sequence.toString()),
        loanTapeMerkleRoot: Array.from(args.merkleRoot),
        signature: Array.from(signature),
      })
      .accounts({
        pool: pool.publicKey,
        navAccount: navPda,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(updateIx);
    return provider.sendAndConfirm(tx, []);
  }

  it("publisher can publish a self-consistent update", async () => {
    const merkleRoot = Buffer.alloc(32, 7);
    const navGross = 1_000_000_000n; // 1.0 in 9-decimal
    const terBps = 150; // 1.50%
    const lossBps = 180; // 1.80%
    // nav_net = nav_gross × (10000 − 150 − 180) / 10000 = nav_gross × 9670 / 10000
    const navNet = (navGross * 9670n) / 10_000n;

    await buildAndSendUpdate({
      navNet,
      navGross,
      terBps,
      lossBps,
      navType: 0,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
      sequence: 1n,
      merkleRoot,
    });

    const acct = await program.account.navAccount.fetch(navPda);
    expect(acct.sequence.toNumber()).to.equal(1);
    expect(acct.navNet.toString()).to.equal(navNet.toString());
    expect(acct.navGross.toString()).to.equal(navGross.toString());
    expect(acct.terBps).to.equal(terBps);
    expect(acct.lossProvisionBps).to.equal(lossBps);
  });

  it("rejects stale sequence", async () => {
    // Try sequence=1 again after we just wrote sequence=1 above.
    const merkleRoot = Buffer.alloc(32, 7);
    const navGross = 1_000_000_000n;
    const terBps = 150;
    const lossBps = 180;
    const navNet = (navGross * 9670n) / 10_000n;

    try {
      await buildAndSendUpdate({
        navNet,
        navGross,
        terBps,
        lossBps,
        navType: 0,
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
        sequence: 1n,
        merkleRoot,
      });
      expect.fail("expected StaleSequence error");
    } catch (e: any) {
      const msg = (e?.logs?.join("\n") ?? "") + "\n" + (e?.message ?? "");
      expect(msg).to.match(/StaleSequence|stale[\s_-]*sequence|0x1b58|7000/i);
    }
  });

  it("rejects InconsistentNav when nav_net != nav_gross × (1 − ter − loss)", async () => {
    // Use sequence=2, but set nav_net = nav_gross (no fee deduction). Expect InconsistentNav.
    const merkleRoot = Buffer.alloc(32, 7);
    const navGross = 1_000_000_000n;
    const terBps = 150;
    const lossBps = 180;
    const navNet = navGross; // wrong — should be navGross * 9670/10000

    try {
      await buildAndSendUpdate({
        navNet,
        navGross,
        terBps,
        lossBps,
        navType: 0,
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
        sequence: 2n,
        merkleRoot,
      });
      expect.fail("expected InconsistentNav error");
    } catch (e: any) {
      const msg = (e?.logs?.join("\n") ?? "") + "\n" + (e?.message ?? "");
      expect(msg).to.match(/InconsistentNav|inconsistent[\s_-]*nav|0x1b5a|7002/i);
    }
  });
});
