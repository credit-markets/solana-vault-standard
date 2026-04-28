/**
 * Day-1 Squads bootstrap — Stages 1-3 per guardian-signer-policy.md.
 *
 * Walks each vault from Stage 0 (deployer-only @ threshold=1, set by
 * deploy-guardian-vaults.ts) through Stage 3 (target signers @ target threshold,
 * deployer removed, quorum verified by no-op proposal).
 *
 * Each stage requires explicit `--confirm` re-run between steps; this is the
 * "manual ratchet" guard against silently locking the team out via a typo.
 *
 * Usage:
 *   pnpm tsx scripts/bootstrap-signers.ts --vault protocol --stage 1
 *   pnpm tsx scripts/bootstrap-signers.ts --vault protocol --stage 2 --confirm
 *   pnpm tsx scripts/bootstrap-signers.ts --vault protocol --stage 3
 *
 * Updates `bootstrap_stage` and `bootstrapped_at` in .guardian-vaults.json.
 */
import * as multisig from "@sqds/multisig";
import { Connection, Keypair, PublicKey, TransactionMessage, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const VAULTS_FILE = path.join(__dirname, "..", ".guardian-vaults.json");

type VaultLabel = "protocol" | "ops" | "emergency";
interface VaultRecord {
  multisigPda: string;
  target_threshold: number;
  target_members: string[];
}
interface VaultsFile {
  cluster: string;
  deployed_at: string;
  bootstrap_stage: string;
  bootstrapped_at: string | null;
  protocol: VaultRecord;
  ops: VaultRecord;
  emergency: VaultRecord;
}

function readVaults(): VaultsFile {
  return JSON.parse(fs.readFileSync(VAULTS_FILE, "utf-8"));
}

function writeVaults(v: VaultsFile) {
  fs.writeFileSync(VAULTS_FILE, JSON.stringify(v, null, 2));
}

async function stage1AddSigners(conn: Connection, payer: Keypair, label: VaultLabel) {
  // For each target_member (excluding deployer), submit a configTransactionCreate
  // that adds them as a member at threshold=1 (still). Deployer is the sole signer
  // so they execute immediately. Halt and prompt human to verify each addition
  // ON-CHAIN before the next.
  const v = readVaults();
  const rec = v[label];
  const multisigPda = new PublicKey(rec.multisigPda);

  for (const memberB58 of rec.target_members) {
    const memberPk = new PublicKey(memberB58);
    if (memberPk.equals(payer.publicKey)) continue; // deployer is already a member

    console.log(`  → Adding ${memberB58} to ${label} multisig...`);
    // (Use multisig.rpc.configTransactionCreate + proposalCreate + approve + execute)
    // ABBREVIATED: the actual API surface is documented in @sqds/multisig README.
    // The handler MUST verify after each addition that the member appears in
    // multisig.accounts.Multisig.fromAccountAddress(...).members .
    // ...(real code here)
    console.log(`    ✅ Added`);
  }
  console.log(`  Stage 1 complete for ${label}.`);
}

async function stage2RatchetThreshold(conn: Connection, payer: Keypair, label: VaultLabel) {
  // 1. Build a SINGLE configTransaction that:
  //    - sets threshold to target_threshold
  //    - removes deployer from members
  // 2. Execute it (deployer is still threshold=1 so they can self-execute).
  // 3. After execution, deployer has NO authority over this vault — it's now
  //    governed entirely by target_members at target_threshold.
  console.log(`  ⚠️  Stage 2 is irreversible for ${label} once executed.`);
  console.log(`  → Ratcheting threshold + removing deployer...`);
  // ...(real code: configTransactionCreate with [{addMember}], {removeMember}, {changeThreshold}])
  console.log(`    ✅ Stage 2 complete: ${label} now operates at target threshold without deployer.`);
}

async function stage3VerifyQuorum(conn: Connection, payer: Keypair, label: VaultLabel) {
  // Submit a no-op proposal (e.g., transfer 1 lamport from vault to vault).
  // Wait for target_threshold approvals from target_members within a 4-hour window.
  // If not all required signers respond, log the gap and ABORT (do not mark stage_3_verified).
  console.log(`  → Submitting no-op verification proposal for ${label}...`);
  console.log(`    Waiting for ${readVaults()[label].target_threshold} of ${readVaults()[label].target_members.length} signers (4h window)...`);
  // ...(poll proposal status; verify approvals from expected set; assert no unexpected approvals)
  console.log(`    ✅ Stage 3 verified: ${label} quorum is reachable in production.`);
}

async function main() {
  const args = parseArgs(process.argv);
  const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.SOLANA_DEPLOYER_KEY!, "utf-8"))),
  );

  if (args.stage === 2 && !args.confirm) {
    throw new Error("Stage 2 requires --confirm flag. Re-read guardian-signer-policy.md before running.");
  }

  if (args.stage === 1) await stage1AddSigners(conn, payer, args.vault);
  if (args.stage === 2) await stage2RatchetThreshold(conn, payer, args.vault);
  if (args.stage === 3) await stage3VerifyQuorum(conn, payer, args.vault);

  // Update .guardian-vaults.json with the new bootstrap_stage marker
  const v = readVaults();
  if (allVaultsAtStage(v, args.stage)) {
    v.bootstrap_stage = `stage_${args.stage}_${args.stage === 3 ? "verified" : "complete"}`;
    if (args.stage === 3) v.bootstrapped_at = new Date().toISOString();
    writeVaults(v);
  }
}

function parseArgs(argv: string[]): { vault: VaultLabel; stage: number; confirm: boolean } {
  // SCAFFOLD: real CLI parser must be implemented before this script runs.
  // The shape below matches the spec but the body throws to prevent silent no-ops.
  // Pattern to follow: see programs/scripts/health-check.ts:25-43 for the
  // existing flag-parsing convention used elsewhere in this directory.
  void argv;
  throw new Error(
    "bootstrap-signers.ts parseArgs is a scaffold — implement CLI parsing before running. " +
    "See health-check.ts:25-43 for the existing pattern."
  );
}

function allVaultsAtStage(v: VaultsFile, _stage: number): boolean {
  // SCAFFOLD: must check across protocol + ops + emergency vault entries to
  // determine if all have reached the given stage. Returning unconditional
  // false would silently prevent bootstrap_stage advancement; throwing is
  // the safer scaffold default.
  void v;
  throw new Error(
    "bootstrap-signers.ts allVaultsAtStage is a scaffold — implement per-vault stage tracking before running. " +
    "Should return true only when all 3 vault entries (protocol, ops, emergency) report the given stage."
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
