/**
 * Deploys 3 Squads multisig vaults on devnet:
 * - Protocol Guardian (3-of-5)
 * - Ops Guardian (2-of-3)
 * - Emergency Guardian (2-of-3)
 *
 * Persists vault addresses to programs/.guardian-vaults.json for downstream tasks.
 *
 * Usage: pnpm tsx scripts/deploy-guardian-vaults.ts
 */
import * as multisig from "@sqds/multisig";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const CLUSTER = process.env.SOLANA_CLUSTER ?? "devnet";
const RPC = CLUSTER === "devnet"
  ? "https://api.devnet.solana.com"
  : process.env.SOLANA_RPC_URL!;

interface VaultConfig {
  label: "protocol" | "ops" | "emergency";
  threshold: number;
  members: PublicKey[]; // populated from env or signer list
}

function loadSignerSet(label: string, count: number): PublicKey[] {
  const env = process.env[`GUARDIAN_${label.toUpperCase()}_SIGNERS`];
  if (!env) {
    throw new Error(
      `GUARDIAN_${label.toUpperCase()}_SIGNERS env var missing — comma-separated base58 pubkeys`,
    );
  }
  const keys = env.split(",").map((k) => new PublicKey(k.trim()));
  if (keys.length !== count) {
    throw new Error(
      `${label} guardian expects ${count} signers, got ${keys.length}`,
    );
  }
  return keys;
}

const vaultConfigs: VaultConfig[] = [
  { label: "protocol", threshold: 3, members: loadSignerSet("PROTOCOL", 5) },
  { label: "ops", threshold: 2, members: loadSignerSet("OPS", 3) },
  { label: "emergency", threshold: 2, members: loadSignerSet("EMERGENCY", 3) },
];

async function deployVault(
  conn: Connection,
  payer: Keypair,
  cfg: VaultConfig,
  treasury: PublicKey,
): Promise<{ multisigPda: PublicKey; targetThreshold: number; targetMembers: string[]; deploySignature: string }> {
  // Stage 0 of the Day-1 bootstrap (per signer-policy doc):
  //   Deploy at threshold=1 with deployer as the SOLE member. The real signer set
  //   (cfg.members at cfg.threshold) is RECORDED as the target state in
  //   .guardian-vaults.json, but is NOT applied here — bootstrap-signers.ts
  //   walks Stages 1-3 with explicit human signer confirmation between steps.
  // DO NOT shortcut this by deploying at the final threshold directly — if even
  // one signer's pubkey is wrong or unreachable, the vault becomes unusable
  // because no quorum can be reached to fix it.
  //
  // `treasury` is the global Squads-controlled PDA from ProgramConfig, NOT the
  // deployer pubkey — Squads V4 routes the multisig creation fee to it. See
  // main() for derivation. (Earlier draft passed payer.publicKey here and hit
  // InvalidAccount 6014 from the on-chain assert at multisig_create.rs:69.)
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });

  const sig = await multisig.rpc.multisigCreateV2({
    connection: conn,
    creator: payer,
    multisigPda,
    configAuthority: null,           // controlled by members (deployer-only at this stage)
    threshold: 1,                    // STAGE 0 — deployer-only quorum
    members: [{
      key: payer.publicKey,
      permissions: multisig.types.Permissions.all(),
    }],
    timeLock: 0, // Initial deploy has no timelock; future hardening can add a 48h delay for the Protocol Guardian.
    createKey,
    rentCollector: null,
    treasury,
  });

  console.log(`✅ Stage 0: ${cfg.label} deployed at threshold=1 (deployer-only) — ${multisigPda.toBase58()} (sig: ${sig})`);
  console.log(`   target_threshold=${cfg.threshold}  target_members=${cfg.members.length} keys (apply via bootstrap-signers.ts)`);

  return {
    multisigPda,
    targetThreshold: cfg.threshold,
    targetMembers: cfg.members.map((pk) => pk.toBase58()),
    deploySignature: sig,
  };
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.SOLANA_DEPLOYER_KEY!, "utf-8"))),
  );

  // Squads V4 requires routing the multisig creation fee to the treasury PDA
  // stored in the global ProgramConfig (NOT an arbitrary deployer-controlled
  // address). Read once and reuse across all 3 vault deploys.
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(
    conn,
    programConfigPda,
  );
  const treasury = programConfig.treasury;
  console.log(`📋 Squads programConfig: ${programConfigPda.toBase58()}`);
  console.log(`💰 Treasury (creation fee sink): ${treasury.toBase58()}`);
  console.log(`💵 Multisig creation fee: ${programConfig.multisigCreationFee.toString()} lamports\n`);

  const results: Record<string, { multisigPda: string; target_threshold: number; target_members: string[]; deploy_signature: string }> = {};
  for (const cfg of vaultConfigs) {
    const r = await deployVault(conn, payer, cfg, treasury);
    results[cfg.label] = {
      multisigPda: r.multisigPda.toBase58(),
      target_threshold: r.targetThreshold,
      target_members: r.targetMembers,
      deploy_signature: r.deploySignature,
    };
  }

  const out = path.join(__dirname, "..", ".guardian-vaults.json");
  fs.writeFileSync(out, JSON.stringify({
    cluster: CLUSTER,
    deployed_at: new Date().toISOString(),
    bootstrap_stage: "stage_0_deployer_only",  // bootstrap-signers.ts updates this through stage_3_verified
    bootstrapped_at: null,
    ...results,
  }, null, 2));
  console.log(`\nWrote vault addresses to ${out}`);
  console.log(`\n⚠️  NEXT STEP: run \`pnpm tsx scripts/bootstrap-signers.ts\` to ratchet through Stages 1-3.`);
  console.log(`    Do NOT begin authority migration until bootstrap_stage === "stage_3_verified".`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
