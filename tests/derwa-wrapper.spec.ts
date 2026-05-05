/**
 * derwa-wrapper integration tests.
 *
 * Scope: this is a UNIT-level integration test of the wrapper logic only.
 * It does NOT exercise the Token-2022 TransferHook → ComplianceHook path
 * because:
 *   1. Original spec deferred MintConfig + ExtraAccountMetaList init
 *      to the deployment runbook (compliance-hook lacks a
 *      public initialize_mint_config ix). Without those PDAs the hook
 *      cannot resolve extra accounts on the in-CPI transfer_checked path.
 *   2. Even with those PDAs, the wrapper's `wrap` / `unwrap` CPIs would
 *      need remaining_accounts forwarding (Token-2022 auto-resolution
 *      doesn't apply to CPI). That gap is documented in wrap.rs / unwrap.rs.
 *
 * What we test here:
 *   ✅ wrap moves cPOOL → wrapper PDA + mints dePOOL 1:1 + bumps locked_supply
 *   ✅ unwrap with valid attestation burns dePOOL + releases cPOOL + decrements locked_supply
 *   ✅ unwrap without attestation rejects with AttestationRequired (8001)
 *
 * What we DO NOT test (deferred to the e2e deployment runbook):
 *   ❌ Hook-enforced sanctions checks during wrap (cPOOL transfer)
 *   ❌ Hook-enforced attestation checks during unwrap (cPOOL transfer)
 *   ❌ Mint-substitution attacks via wrap to a different (cPOOL, dePOOL) pair
 *      — partially covered by the MintMismatch constraint compile-time test
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccountIdempotent,
  mintTo,
  setAuthority,
  AuthorityType,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

import { DerwaWrapper } from "../target/types/derwa_wrapper";
import { MockSas as MockAttestation } from "../target/types/mock_sas";

// Mock-sas program ID — matches Anchor.toml entry. Same constant used by
// svs-11.ts; if mock-sas is redeployed, both must update.
const ATTESTATION_PROGRAM_ID = new PublicKey(
  "GTTMWDHTZibyEpqNRr33RnBhgms262U6qHaGrjoHqEXg",
);
const FAR_FUTURE_EXPIRY = new BN(4_102_444_800); // ~year 2100

describe("derwa-wrapper: wrap + unwrap roundtrip", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.DerwaWrapper as Program<DerwaWrapper>;
  const mockSas = anchor.workspace.MockSas as Program<MockAttestation>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Test-scoped principals.
  const investor = Keypair.generate();
  const attester = Keypair.generate(); // issuer of the SVS-11 attestation
  const pool = Keypair.generate(); // stand-in for CreditVault PDA — wrapper
  // doesn't deserialize, so any pubkey works

  // Per-test-setup-derived state.
  let permissionedMint: PublicKey; // cPOOL
  let derwaMint: PublicKey; // dePOOL
  let wrapperConfigPda: PublicKey;
  let wrapperSignerPda: PublicKey;
  let investorPermAta: PublicKey;
  let investorDerwaAta: PublicKey;
  let wrapperLockedAta: PublicKey;
  let attestationPda: PublicKey;

  const WRAP_AMOUNT = new BN(1_000_000); // 1.0 token at 6 decimals

  before(async () => {
    // Fund investor for tx fees + ATA rent.
    const sig = await connection.requestAirdrop(
      investor.publicKey,
      5 * LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(sig);

    // Derive wrapper PDAs (must match seeds in derwa-wrapper state.rs).
    [wrapperConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wrapper_config"), pool.publicKey.toBuffer()],
      program.programId,
    );
    [wrapperSignerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wrapper_signer"), pool.publicKey.toBuffer()],
      program.programId,
    );

    // Create cPOOL (permissioned mint). For these unit tests we DO NOT bind
    // the TransferHook extension — the hook integration is deferred to the
    // deployment runbook (see file header). Investor is the initial
    // mint authority just so we can fund the investor's cPOOL ATA.
    permissionedMint = await createMint(
      connection,
      payer,
      investor.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    // Create dePOOL with `wrapperSignerPda` as the mint authority directly
    // — the wrapper PDA is the only entity allowed to mint dePOOL via wrap().
    // Setting it at create time avoids the round-trip of createMint + setAuthority.
    derwaMint = await createMint(
      connection,
      payer,
      wrapperSignerPda,
      wrapperSignerPda,
      6,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    // Create the three required ATAs.
    investorPermAta = await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      permissionedMint,
      investor.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    investorDerwaAta = await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      derwaMint,
      investor.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    // wrapperSignerPda is a PDA (off-curve) — pass allowOwnerOffCurve=true.
    // The signature is positional: (connection, payer, mint, owner,
    // confirmOptions?, programId?, associatedTokenProgramId?, allowOwnerOffCurve?).
    wrapperLockedAta = await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      permissionedMint,
      wrapperSignerPda,
      undefined,
      TOKEN_2022_PROGRAM_ID,
      undefined,
      true,
    );

    // Mint cPOOL to investor — provides the source funds for the wrap test.
    // Investor is the cPOOL mint authority (test-only convenience).
    await mintTo(
      connection,
      payer,
      permissionedMint,
      investorPermAta,
      investor,
      10_000_000, // 10.0 cPOOL
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    // Initialize the wrapper for this pool.
    //
    // Trust anchors: bind the wrapper to the mock-sas attestation
    // program + the test-scoped `attester` issuer + attestation_type 0.
    // The on-chain `unwrap` handler will validate destination
    // attestations against these anchors via the
    // owner / subject / issuer / type / canonical-PDA chain.
    await program.methods
      .initialize({
        attestationProgram: ATTESTATION_PROGRAM_ID,
        attestationIssuer: attester.publicKey,
        requiredAttestationType: 0,
      })
      .accountsPartial({
        pool: pool.publicKey,
        wrapperConfig: wrapperConfigPda,
        permissionedMint,
        derwaMint,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("wrap moves cPOOL to wrapper PDA + mints dePOOL 1:1", async () => {
    const investorPermBefore = await getAccount(
      connection,
      investorPermAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const investorDerwaBefore = await getAccount(
      connection,
      investorDerwaAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const wrapperLockedBefore = await getAccount(
      connection,
      wrapperLockedAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    await program.methods
      .wrap(WRAP_AMOUNT)
      .accountsPartial({
        wrapperConfig: wrapperConfigPda,
        wrapperSigner: wrapperSignerPda,
        permissionedMint,
        derwaMint,
        investorPermissionedAta: investorPermAta,
        wrapperLockedAta,
        investorDerwaAta,
        investor: investor.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([investor])
      .rpc();

    // Balance assertions: cPOOL moved investor → wrapper, dePOOL minted to investor.
    const investorPermAfter = await getAccount(
      connection,
      investorPermAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const investorDerwaAfter = await getAccount(
      connection,
      investorDerwaAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const wrapperLockedAfter = await getAccount(
      connection,
      wrapperLockedAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const wrapAmt = BigInt(WRAP_AMOUNT.toString());

    expect(investorPermAfter.amount).to.equal(
      investorPermBefore.amount - wrapAmt,
    );
    expect(wrapperLockedAfter.amount).to.equal(
      wrapperLockedBefore.amount + wrapAmt,
    );
    expect(investorDerwaAfter.amount).to.equal(
      investorDerwaBefore.amount + wrapAmt,
    );

    // locked_supply on-chain matches.
    const cfg = await program.account.wrapperConfig.fetch(wrapperConfigPda);
    expect(cfg.lockedSupply.eq(WRAP_AMOUNT)).to.be.true;
  });

  it("unwrap with valid attestation burns dePOOL + releases cPOOL", async () => {
    // Create a real attestation PDA for the investor via mock-sas. The
    // mock-sas attestation layout matches what compliance-hook + unwrap
    // both read (129 bytes total, expires_at at payload[75..83], revoked
    // at payload[83]).
    [attestationPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("attestation"),
        investor.publicKey.toBuffer(),
        attester.publicKey.toBuffer(),
        Buffer.from([0]), // attestation_type = 0 (KYB tier 0)
      ],
      ATTESTATION_PROGRAM_ID,
    );

    await mockSas.methods
      .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
      .accountsPartial({
        authority: payer.publicKey,
        attestation: attestationPda,
        subject: investor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const investorPermBefore = await getAccount(
      connection,
      investorPermAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const investorDerwaBefore = await getAccount(
      connection,
      investorDerwaAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    await program.methods
      .unwrap(WRAP_AMOUNT)
      .accountsPartial({
        wrapperConfig: wrapperConfigPda,
        wrapperSigner: wrapperSignerPda,
        permissionedMint,
        derwaMint,
        wrapperLockedAta,
        investorPermissionedAta: investorPermAta,
        investorDerwaAta,
        investorAttestation: attestationPda,
        investor: investor.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([investor])
      .rpc();

    const investorPermAfter = await getAccount(
      connection,
      investorPermAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const investorDerwaAfter = await getAccount(
      connection,
      investorDerwaAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const wrapAmt = BigInt(WRAP_AMOUNT.toString());

    // cPOOL flows back, dePOOL gets burned.
    expect(investorPermAfter.amount).to.equal(
      investorPermBefore.amount + wrapAmt,
    );
    expect(investorDerwaAfter.amount).to.equal(
      investorDerwaBefore.amount - wrapAmt,
    );

    // locked_supply now zero.
    const cfg = await program.account.wrapperConfig.fetch(wrapperConfigPda);
    expect(cfg.lockedSupply.eqn(0)).to.be.true;
  });

  it("unwrap without attestation fails with AttestationRequired (8001)", async () => {
    // First, re-wrap so we have something to attempt to unwrap.
    await program.methods
      .wrap(WRAP_AMOUNT)
      .accountsPartial({
        wrapperConfig: wrapperConfigPda,
        wrapperSigner: wrapperSignerPda,
        permissionedMint,
        derwaMint,
        investorPermissionedAta: investorPermAta,
        wrapperLockedAta,
        investorDerwaAta,
        investor: investor.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([investor])
      .rpc();

    // Pass a random non-existent pubkey as the attestation account.
    // The unwrap handler now performs the owner check FIRST (`att.owner
    // == wrapper_config.attestation_program`) — this fails for a default-
    // zero system account because its `owner` is the system program, not
    // mock-sas. So the first rejection is `InvalidAttestationProgram`
    // (8004), NOT `AttestationRequired` (8001) like the prior
    // existence-first ordering produced.
    //
    // Owner-first ordering is the safer security posture: a single
    // Pubkey comparison rejects forgeries from foreign programs before
    // any payload reads happen. Both error codes mean "the attestation
    // is unusable" so the test accepts either.
    const fakeAttestation = Keypair.generate().publicKey;

    let errored = false;
    try {
      await program.methods
        .unwrap(WRAP_AMOUNT)
        .accountsPartial({
          wrapperConfig: wrapperConfigPda,
          wrapperSigner: wrapperSignerPda,
          permissionedMint,
          derwaMint,
          wrapperLockedAta,
          investorPermissionedAta: investorPermAta,
          investorDerwaAta,
          investorAttestation: fakeAttestation,
          investor: investor.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([investor])
        .rpc();
    } catch (e: unknown) {
      errored = true;
      const errStr = String(e);
      // Either rejection is acceptable: 8001 = AttestationRequired,
      // 8004 = InvalidAttestationProgram. Iteration-1 ordering yields
      // 8004 first; if a future re-ordering (existence-first) ever
      // ships, 8001 would be expected — both indicate the unwrap
      // handler refused.
      expect(
        errStr.includes("InvalidAttestationProgram") ||
          errStr.includes("AttestationRequired") ||
          errStr.includes("0x1f41") || // hex(8001)
          errStr.includes("0x1f44") || // hex(8004)
          errStr.includes("8001") ||
          errStr.includes("8004"),
      ).to.equal(
        true,
        `Expected attestation-validation rejection, got: ${errStr}`,
      );
    }
    expect(errored).to.equal(true, "unwrap should have rejected");
  });

  it("rejects unwrap when attestation belongs to a DIFFERENT subject (8005)", async () => {
    // Security-class check: a previous version of the unwrap handler
    // only validated existence + revoked + expires, NEVER reading the
    // `subject` field of the attestation payload. That meant any holder
    // of dePOOL could pass ANY pre-existing valid attestation account
    // (e.g. a friend's KYC'd attestation) and unwrap into the
    // permissioned cPOOL — defeating the entire Permissioned-mode
    // invariant.
    //
    // The fix reads `payload[0..32]` (subject) and compares to
    // investor.key(); a mismatch surfaces as
    // `InvalidAttestationSubject` (8005). This test creates a
    // VALID attestation for a *different* wallet (`stranger`) under
    // the *same* issuer + type, then attempts to unwrap with it.
    // Pre-fix this would have silently succeeded.

    const stranger = Keypair.generate();
    const [strangerAttestation] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("attestation"),
        stranger.publicKey.toBuffer(),
        attester.publicKey.toBuffer(),
        Buffer.from([0]), // same attestation_type as investor
      ],
      ATTESTATION_PROGRAM_ID,
    );

    // Create the stranger's attestation. Note: we DO NOT fund the
    // stranger or have them sign anything — the attestation creation
    // signer is the test payer (mock-sas accepts any signer for create
    // by design).
    await mockSas.methods
      .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
      .accountsPartial({
        authority: payer.publicKey,
        attestation: strangerAttestation,
        subject: stranger.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // First, re-wrap something so we have a position to attempt to unwrap.
    // (The previous test fully unwrapped to zero.)
    await program.methods
      .wrap(WRAP_AMOUNT)
      .accountsPartial({
        wrapperConfig: wrapperConfigPda,
        wrapperSigner: wrapperSignerPda,
        permissionedMint,
        derwaMint,
        investorPermissionedAta: investorPermAta,
        wrapperLockedAta,
        investorDerwaAta,
        investor: investor.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([investor])
      .rpc();

    // Attempt unwrap with the stranger's attestation. The investor is
    // still the tx signer, so all token-program checks pass — only the
    // attestation subject check (now hardened) should reject.
    let errored = false;
    try {
      await program.methods
        .unwrap(WRAP_AMOUNT)
        .accountsPartial({
          wrapperConfig: wrapperConfigPda,
          wrapperSigner: wrapperSignerPda,
          permissionedMint,
          derwaMint,
          wrapperLockedAta,
          investorPermissionedAta: investorPermAta,
          investorDerwaAta,
          investorAttestation: strangerAttestation, // ← stranger's, not investor's
          investor: investor.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([investor])
        .rpc();
    } catch (e: unknown) {
      errored = true;
      const errStr = String(e);
      // 8005 = 0x1f45 = InvalidAttestationSubject.
      expect(
        errStr.includes("InvalidAttestationSubject") ||
          errStr.includes("0x1f45") ||
          errStr.includes("8005"),
      ).to.equal(
        true,
        `Expected InvalidAttestationSubject error, got: ${errStr}`,
      );
    }
    expect(errored).to.equal(
      true,
      "unwrap with foreign attestation should have rejected",
    );
  });
});
