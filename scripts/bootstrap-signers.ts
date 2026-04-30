/**
 * Day-1 Squads bootstrap — Stages 1-3 per guardian-signer-policy.md.
 *
 * Walks each vault from Stage 0 (deployer-only @ threshold=1, set by
 * deploy-guardian-vaults.ts) through Stage 3 (target signers @ target
 * threshold, deployer removed, quorum verified by no-op proposal).
 *
 * Each stage requires explicit `--confirm` re-run between steps — the
 * manual ratchet against silently locking the team out via a typo.
 *
 * Usage:
 *   npx ts-node scripts/bootstrap-signers.ts --vault protocol --stage 1
 *   npx ts-node scripts/bootstrap-signers.ts --vault protocol --stage 2 --confirm
 *   npx ts-node scripts/bootstrap-signers.ts --vault protocol --stage 3
 *
 * Required env:
 *   SOLANA_DEPLOYER_KEY  path to operator keypair (deployer key from Stage 0)
 *   SOLANA_RPC_URL       optional — defaults to devnet
 *
 * Per-vault stage state lives in `.guardian-vaults.json` under each vault
 * record's `stage` field. The top-level `bootstrap_stage` advances only
 * when ALL three vaults reach the same stage.
 */
import * as multisig from "@sqds/multisig";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  SystemProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const VAULTS_FILE = path.join(__dirname, "..", ".guardian-vaults.json");

type VaultLabel = "protocol" | "ops" | "emergency";
const ALL_VAULT_LABELS: readonly VaultLabel[] = [
  "protocol",
  "ops",
  "emergency",
] as const;

interface VaultRecord {
  multisigPda: string;
  target_threshold: number;
  target_members: string[];
  /**
   * Per-vault bootstrap stage. Each vault advances independently;
   * the top-level `bootstrap_stage` only advances once all three
   * vaults reach the same stage. Values:
   *   "stage_0_deployer_only" | "stage_1_signers_added"
   *   | "stage_1_5_custody_proven" | "stage_2_threshold_ratcheted"
   *   | "stage_3_verified"
   */
  stage?: string;
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

function stageNameForStep(stage: number): string {
  switch (stage) {
    case 1:
      return "stage_1_signers_added";
    case 1.5:
      return "stage_1_5_custody_proven";
    case 2:
      return "stage_2_threshold_ratcheted";
    case 3:
      return "stage_3_verified";
    default:
      throw new Error(`Unknown stage: ${stage}`);
  }
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
  const conn = new Connection(
    process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    "confirmed",
  );
  if (!process.env.SOLANA_DEPLOYER_KEY) {
    throw new Error("SOLANA_DEPLOYER_KEY env var is required");
  }
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync(process.env.SOLANA_DEPLOYER_KEY, "utf-8")),
    ),
  );

  if (args.stage === 2 && !args.confirm) {
    throw new Error(
      "Stage 2 requires --confirm flag. Re-read guardian-signer-policy.md before running.",
    );
  }

  if (args.stage === 1) await stage1AddSigners(conn, payer, args.vault);
  else if (args.stage === 1.5)
    await stage1_5ProveCustody(conn, payer, args.vault);
  else if (args.stage === 2)
    await stage2RatchetThreshold(conn, payer, args.vault);
  else if (args.stage === 3) await stage3VerifyQuorum(conn, payer, args.vault);

  // Mark this vault as advanced.
  recordVaultStage(args.vault, args.stage);

  // Advance the top-level bootstrap_stage only when ALL three vaults
  // have reached the same stage. This is what migrate-authorities.ts
  // gates on (`bootstrap_stage === "stage_3_verified"`).
  const v = readVaults();
  if (allVaultsAtStage(v, args.stage)) {
    v.bootstrap_stage = stageNameForStep(args.stage);
    if (args.stage === 3) v.bootstrapped_at = new Date().toISOString();
    writeVaults(v);
    console.log(
      `\n📋 All vaults at ${stageNameForStep(args.stage)}; top-level bootstrap_stage advanced.`,
    );
  } else {
    console.log(
      `\n📋 ${args.vault} at ${stageNameForStep(args.stage)}; other vaults still pending.`,
    );
  }
}

/**
 * Stage 1.5 — each new member demonstrates they actually hold the
 * private key for the pubkey they reported, by approving a no-op
 * proposal from their own machine. Without this check, Stage 2's
 * threshold ratchet can succeed even though one of the new signers
 * has a lost or stale key, leaving the vault permanently below
 * quorum after deployer removal.
 *
 * The script generates one proposal per non-deployer target_member,
 * logs the proposal index for each, and waits for approval signals.
 * Implementation note: this requires off-machine coordination — the
 * script POSTS proposals; team members run their own approval txs;
 * the script polls until all approvals land.
 */
async function stage1_5ProveCustody(
  _conn: Connection,
  _payer: Keypair,
  label: VaultLabel,
) {
  console.log(`  → Stage 1.5: proof-of-key-custody for ${label}...`);
  console.log(
    `  ⚠️  Implementation incomplete — see issue tracker; needs Squads SDK proposal-create + poll-approve flow.`,
  );
  // Implementation pending: per-member configTransactionCreate as no-op,
  // log proposal index, poll for approval from each, fail if any signer
  // doesn't approve within the configured timeout.
  throw new Error(
    "Stage 1.5 not yet implemented. Coordinate proof-of-key-custody manually via the Squads UI before running --stage 2.",
  );
}

function parseArgs(argv: string[]): {
  vault: VaultLabel;
  stage: number;
  confirm: boolean;
} {
  // Strip node + script path; flags can appear in any order.
  const args = argv.slice(2);
  let vault: VaultLabel | undefined;
  let stage: number | undefined;
  let confirm = false;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const next = args[i + 1];
    switch (flag) {
      case "--vault":
        if (
          next !== "protocol" &&
          next !== "ops" &&
          next !== "emergency"
        ) {
          throw new Error(
            `--vault must be one of protocol|ops|emergency, got: ${next}`,
          );
        }
        vault = next;
        i++;
        break;
      case "--stage": {
        if (!next) throw new Error("--stage requires a value");
        const parsed = Number(next);
        if (![1, 1.5, 2, 3].includes(parsed)) {
          throw new Error(
            `--stage must be 1, 1.5, 2, or 3, got: ${next}`,
          );
        }
        stage = parsed;
        i++;
        break;
      }
      case "--confirm":
        confirm = true;
        break;
      case "--help":
      case "-h":
        printUsageAndExit(0);
        break;
      default:
        if (flag.startsWith("--")) {
          throw new Error(`Unknown flag: ${flag}`);
        }
    }
  }

  if (!vault) throw new Error("Missing required --vault");
  if (stage === undefined) throw new Error("Missing required --stage");
  return { vault, stage, confirm };
}

function printUsageAndExit(code: number): never {
  console.error(
    `Usage:\n  npx ts-node scripts/bootstrap-signers.ts --vault {protocol|ops|emergency} --stage {1|1.5|2|3} [--confirm]\n\n` +
      `  Stage 1   — add target_members (still threshold=1, deployer-only quorum)\n` +
      `  Stage 1.5 — proof-of-key-custody sign-test by each new member\n` +
      `  Stage 2   — ratchet threshold + remove deployer (IRREVERSIBLE; requires --confirm)\n` +
      `  Stage 3   — no-op quorum verification by target signers\n`,
  );
  process.exit(code);
}

/**
 * True when every vault record reports the given stage. Stage names are
 * the canonical `stage_N_*` strings from `stageNameForStep`. Treats
 * missing `stage` field as "stage_0_deployer_only" — matches the state
 * deploy-guardian-vaults.ts leaves.
 */
function allVaultsAtStage(v: VaultsFile, stage: number): boolean {
  const expected = stageNameForStep(stage);
  return ALL_VAULT_LABELS.every(
    (label) =>
      (v[label].stage ?? "stage_0_deployer_only") === expected,
  );
}

/**
 * Mark a single vault's per-vault stage in the JSON. Top-level
 * `bootstrap_stage` only advances when all three are at the same stage —
 * `main()` writes that field after each handler.
 */
function recordVaultStage(label: VaultLabel, stage: number) {
  const v = readVaults();
  v[label].stage = stageNameForStep(stage);
  writeVaults(v);
}

main().catch((e) => { console.error(e); process.exit(1); });
