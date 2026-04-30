/**
 * Migrates non-svs-11 authorities to the appropriate Guardian Squads vault.
 *
 * Usage:
 *   npx ts-node scripts/migrate-authorities.ts <authority> --dry-run
 *   npx ts-node scripts/migrate-authorities.ts <authority> --execute
 *
 * Where <authority> is one of:
 *   sanctions-list   → Ops Guardian
 *
 * Safety primitives:
 *   1. --dry-run is the DEFAULT. Migration only fires with explicit --execute.
 *   2. Pre-flight verifies .guardian-vaults.json bootstrap_stage === "stage_3_verified".
 *   3. Co-signer text confirmation: prompts the operator to type the target
 *      vault's base58 address from a SEPARATE source (the team-shared
 *      signer-policy doc). If the typed value doesn't match the JSON, abort.
 *   4. Logs the FROM and TO authority pubkeys explicitly so two-eyes-on-screen
 *      review can catch typos before --execute.
 *
 * After each migration, run a smoke-test op via the new authority to confirm
 * the migration succeeded. If the smoke test fails, ROLL BACK by re-pointing
 * the authority to the original signer (which is kept available until the
 * smoke test passes).
 *
 * Required env:
 *   SOLANA_DEPLOYER_KEY   path to the operator keypair
 *   SOLANA_RPC_URL        optional override (defaults to devnet)
 */
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import * as multisig from "@sqds/multisig";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

const VAULTS_FILE = path.join(__dirname, "..", ".guardian-vaults.json");
const IDL_FILE = path.join(
  __dirname,
  "..",
  "target",
  "idl",
  "compliance_hook.json",
);

interface VaultRecord {
  multisigPda: string;
  target_threshold: number;
  target_members: string[];
}
interface VaultsFile {
  cluster: string;
  bootstrap_stage: string;
  protocol: VaultRecord;
  ops: VaultRecord;
  emergency: VaultRecord;
}

interface Args {
  which: string;
  isExecute: boolean;
  isDryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const which = argv[0] ?? "";
  const isExecute = argv.includes("--execute");
  // Dry-run is the default-on safety: only --execute disables it.
  const isDryRun = !isExecute || argv.includes("--dry-run");
  return { which, isExecute, isDryRun };
}

function loadVaults(): VaultsFile {
  if (!fs.existsSync(VAULTS_FILE)) {
    throw new Error(
      `${VAULTS_FILE} not found. Run scripts/deploy-guardian-vaults.ts first.`,
    );
  }
  return JSON.parse(fs.readFileSync(VAULTS_FILE, "utf-8"));
}

function loadOperator(): Keypair {
  const keyPath = process.env.SOLANA_DEPLOYER_KEY;
  if (!keyPath) {
    throw new Error("SOLANA_DEPLOYER_KEY env var is required");
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf-8"))),
  );
}

function rpcUrl(cluster: string): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (cluster === "devnet") return "https://api.devnet.solana.com";
  if (cluster === "localnet" || cluster === "localhost")
    return "http://127.0.0.1:8899";
  throw new Error(
    `No RPC URL for cluster=${cluster}. Set SOLANA_RPC_URL explicitly.`,
  );
}

/**
 * Co-signer guard. Asks the operator to retype the destination vault's
 * address from a separate source (the team's policy doc). The signal is
 * NOT that the script knows the right answer — it does. The signal is
 * that two human-readable surfaces (this JSON + the policy doc) AGREE,
 * which catches "I edited the JSON wrong" and "the policy doc is stale"
 * mistakes that would otherwise route authority to the wrong vault.
 */
async function confirmTargetVault(
  label: string,
  expectedB58: string,
  isDryRun: boolean,
  whichAuthority: string,
): Promise<void> {
  if (isDryRun) return;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `\n⚠️  About to migrate "${whichAuthority}" authority to ${label} Guardian.\n` +
        `   Open docs/operations/guardian-signer-policy.md "Devnet vault addresses".\n` +
        `   Re-type the FULL base58 address of ${label} from that doc and press enter:\n  > `,
      resolve,
    );
  });
  rl.close();
  if (answer.trim() !== expectedB58) {
    console.error(
      `❌ Mismatch.\n   You typed:                 ${answer.trim()}\n   .guardian-vaults.json has: ${expectedB58}`,
    );
    console.error(
      `   Either the JSON is wrong, or the policy doc is wrong, or you have a typo.`,
    );
    process.exit(2);
  }
  console.log(`✅ Co-signer confirmation matches.`);
}

async function migrateSanctionsList(
  conn: Connection,
  operator: Keypair,
  vaults: VaultsFile,
  args: Args,
): Promise<void> {
  const opsVault = new PublicKey(vaults.ops.multisigPda);
  const [opsVaultSigner] = multisig.getVaultPda({
    multisigPda: opsVault,
    index: 0,
  });

  // Verify the address really IS a Squads multisig (not a vault sub-PDA
  // from a different multisig that someone copied into the JSON by mistake).
  // Reading the account fails with a useful error if the type is wrong.
  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
    conn,
    opsVault,
  );
  console.log(
    `Multisig verified: ${vaults.ops.multisigPda} has ${multisigAccount.members.length} members at threshold=${multisigAccount.threshold}`,
  );

  await confirmTargetVault(
    "Ops",
    vaults.ops.multisigPda,
    args.isDryRun,
    args.which,
  );

  const idl = JSON.parse(fs.readFileSync(IDL_FILE, "utf-8"));
  const provider = new AnchorProvider(
    conn,
    {
      publicKey: operator.publicKey,
      signTransaction: async (tx: Transaction) => {
        tx.partialSign(operator);
        return tx;
      },
      signAllTransactions: async (txs: Transaction[]) => {
        txs.forEach((t) => t.partialSign(operator));
        return txs;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    {},
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(idl as any, provider);

  const [sanctionsListPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("sanctions_list")],
    program.programId,
  );

  console.log(`\nMigration plan:`);
  console.log(`  authority:        sanctions-list`);
  console.log(`  current holder:   (uninitialized — fresh init)`);
  console.log(
    `  new holder:       Ops Guardian vault signer = ${opsVaultSigner.toBase58()}`,
  );
  console.log(`  multisig PDA:     ${vaults.ops.multisigPda}`);
  console.log(
    `  threshold:        ${multisigAccount.threshold}-of-${multisigAccount.members.length}`,
  );
  console.log(
    `  mode:             ${args.isDryRun ? "DRY-RUN (no on-chain change)" : "EXECUTE"}`,
  );

  if (args.isDryRun) {
    console.log(`\n✅ Dry-run complete. Re-run with --execute to apply.`);
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (program.methods as any)
      .initializeSanctionsList()
      .accounts({
        sanctionsList: sanctionsListPda,
        authority: opsVaultSigner,
        payer: operator.publicKey,
      })
      .rpc();
    console.log(
      `✅ SanctionsList initialized with Ops Guardian (${opsVaultSigner.toBase58()}) as authority`,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("already in use") || msg.includes("0x0")) {
      console.warn(
        "⚠️  SanctionsList already initialized — verifying current authority matches Ops vault",
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = await (program.account as any).sanctionsList.fetch(
        sanctionsListPda,
      );
      if (list.authority.toBase58() !== opsVaultSigner.toBase58()) {
        throw new Error(
          `SanctionsList authority is ${list.authority.toBase58()}, expected ${opsVaultSigner.toBase58()}`,
        );
      }
      console.log(`✅ SanctionsList already correctly owned by Ops Guardian`);
    } else {
      throw e;
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.which) {
    console.error(
      "Usage: npx ts-node scripts/migrate-authorities.ts <authority> [--dry-run | --execute]",
    );
    console.error("Supported authorities: sanctions-list");
    process.exit(1);
  }

  const vaults = loadVaults();

  // Refuse to run if vaults aren't fully bootstrapped.
  if (vaults.bootstrap_stage !== "stage_3_verified") {
    console.error(
      `❌ Refusing to migrate — .guardian-vaults.json bootstrap_stage is "${vaults.bootstrap_stage}".`,
    );
    console.error(
      `   Run scripts/bootstrap-signers.ts through Stage 3 (no-op quorum verification) first.`,
    );
    process.exit(1);
  }

  const conn = new Connection(rpcUrl(vaults.cluster), "confirmed");
  const operator = loadOperator();

  console.log(`\n=== migrate-authorities: ${args.which} ===`);
  console.log(`Cluster:  ${vaults.cluster}`);
  console.log(`Operator: ${operator.publicKey.toBase58()}`);
  console.log(`Mode:     ${args.isDryRun ? "DRY-RUN" : "EXECUTE"}`);

  switch (args.which) {
    case "sanctions-list":
      await migrateSanctionsList(conn, operator, vaults, args);
      break;
    default:
      throw new Error(
        `Unknown authority: ${args.which}. Supported: sanctions-list`,
      );
  }
}

main().catch((e) => {
  console.error(`\n❌ migrate-authorities failed:`);
  console.error(e);
  process.exit(1);
});
