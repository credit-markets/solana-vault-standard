/**
 * Drain Redemption Requests Script.
 *
 * Pre-flight tooling for the bundled SVS-11 upgrade.
 *
 * Enumerates every `RedemptionRequest` PDA whose `vault` field matches
 * the target pool on devnet and prints their state. PDAs in `Pending`
 * are the ones at risk: their account data is laid out per the OLD
 * `RedemptionRequest` struct, and after the bundled upgrade lands the
 * layout grows (3 new fields) so Anchor will fail to deserialize them.
 * They MUST be drained.
 *
 * IMPORTANT: this script runs AFTER backend has flipped
 * `pools.is_redemption_paused = TRUE`. The backend pause stops NEW
 * redemption-tx-builds; this script handles whatever was already
 * pending on-chain.
 *
 * Sequence:
 *   Step 1: backend migration + pause flag      — done in backend
 *   Step 2: flip is_redemption_paused = TRUE    — operator runs
 *   Step 3: this script (3a: dry-run)
 *   Step 3b: 32-slot wait BEFORE drain enumeration — built in
 *           (in-flight txs submitted before the pause may still
 *            land; we wait so the snapshot is complete)
 *   Step 4: dry-run                             — `--dry-run`
 *   Step 5: real drain                          — `--cancel`
 *   Step 6: re-verify zero pending PDAs remain
 *
 * Usage:
 *   npx ts-node scripts/drain-redemption-requests.ts \
 *     --pool <CreditVault-PDA> \
 *     [--cancel] \
 *     [--dry-run] \
 *     [--cluster devnet] \
 *     [--skip-slot-wait]   # ONLY for testing; production must wait
 *
 * Required env:
 *   SVS11_PROGRAM_ID       — devnet SVS-11 program (drain script aborts if unset)
 *   ANCHOR_WALLET          — operator keypair path (defaults to ~/.config/solana/id.json)
 *
 * Cancellation note: `cancel_redeem` requires the INVESTOR as a signer
 * (not the operator). In `--cancel` mode this script surfaces per-PDA
 * details so a follow-up flow can either (a) coordinate investors to
 * self-cancel via the frontend before pause window closes, or
 * (b) admin-freeze + manually close — see the bundled-upgrade runbook.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  clusterApiUrl,
  Keypair,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── CLI parsing ────────────────────────────────────────────────────────────

interface Args {
  pool: string;
  cancel: boolean;
  dryRun: boolean;
  cluster: string;
  skipSlotWait: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.replace("--", "");
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }

  if (typeof flags.pool !== "string" || !flags.pool) {
    console.error(
      "ERROR: --pool <CreditVault-PDA> is required.\n" +
        "Usage: npx ts-node scripts/drain-redemption-requests.ts --pool <pubkey> [--cancel] [--dry-run]",
    );
    process.exit(1);
  }

  return {
    pool: flags.pool,
    cancel: flags.cancel === true,
    dryRun: flags["dry-run"] === true,
    cluster: typeof flags.cluster === "string" ? flags.cluster : "devnet",
    skipSlotWait: flags["skip-slot-wait"] === true,
  };
}

function getConnectionUrl(cluster: string): string {
  if (cluster === "localnet" || cluster === "localhost") {
    return "http://127.0.0.1:8899";
  }
  return clusterApiUrl(cluster as "devnet" | "mainnet-beta" | "testnet");
}

function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

function loadKeypair(filePath: string): Keypair {
  const expanded = expandHome(filePath);
  if (!fs.existsSync(expanded)) {
    console.error(`ERROR: keypair not found at ${expanded}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(expanded, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// ─── 32-slot mempool buffer ─────────────────────────────────────────────────

/**
 * Wait 32 slots (~13 sec at 400ms slot time) for in-flight redeem txs
 * submitted BEFORE the backend pause to land. Without this wait the
 * subsequent enumeration is a stale snapshot and a fresh OLD-layout
 * RedemptionRequest can land mid-drain — defeating the whole purpose
 * of the pause.
 */
async function waitForMempoolBuffer(
  connection: Connection,
  slots = 32,
): Promise<void> {
  const startSlot = await connection.getSlot("confirmed");
  const targetSlot = startSlot + slots;
  console.log(
    `  Waiting ${slots} slots (~${Math.ceil(
      (slots * 400) / 1000,
    )}s) for in-flight txs to land...`,
  );
  console.log(`  Start slot:  ${startSlot}`);
  console.log(`  Target slot: ${targetSlot}`);

  while (true) {
    const current = await connection.getSlot("confirmed");
    if (current >= targetSlot) {
      console.log(`  Reached slot ${current}. Proceeding to drain.\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  console.log("\n" + "=".repeat(70));
  console.log("  Drain RedemptionRequest PDAs");
  console.log("=".repeat(70) + "\n");

  // Ordering check — this script is meaningless if backend pause is not set.
  console.log(
    "  PRECONDITION: pools.is_redemption_paused MUST already be TRUE\n" +
      "  for this pool. This script does NOT verify the backend state — that\n" +
      "  belongs in the bundled-upgrade runbook checklist\n" +
      "  Step 0).\n",
  );

  // Skip-if-unset guard: if SVS11_PROGRAM_ID is not set, abort. The script
  // requires the upgraded SVS-11 program ID to load the IDL and account types.
  const programIdEnv = process.env.SVS11_PROGRAM_ID;
  if (!programIdEnv) {
    console.error(
      "ERROR: SVS11_PROGRAM_ID env var is not set.\n" +
        "  This script will not enumerate without an explicit program ID to\n" +
        "  bind the IDL against. Export SVS11_PROGRAM_ID before re-running.",
    );
    process.exit(1);
  }

  const programId = new PublicKey(programIdEnv);
  const pool = new PublicKey(args.pool);
  const url = getConnectionUrl(args.cluster);
  const connection = new Connection(url, "confirmed");

  const walletPath =
    process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");
  const operator = loadKeypair(walletPath);

  console.log("Configuration:");
  console.log(`  Cluster:    ${args.cluster}`);
  console.log(`  RPC:        ${url}`);
  console.log(`  Program:    ${programId.toBase58()}`);
  console.log(`  Pool:       ${pool.toBase58()}`);
  console.log(`  Operator:   ${operator.publicKey.toBase58()}`);
  console.log(`  Mode:       ${args.cancel ? "CANCEL" : "READ-ONLY"}`);
  console.log(`  Dry-run:    ${args.dryRun ? "yes" : "no"}\n`);

  // Provider just so anchor.Program can be constructed; signing surface only
  // matters if --cancel is on (and even then cancel_redeem requires the
  // INVESTOR signer, not us — see header note).
  const wallet = new anchor.Wallet(operator);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  // Load IDL from build artifacts.
  const idlPath = path.join(__dirname, "..", "target", "idl", "svs_11.json");
  if (!fs.existsSync(idlPath)) {
    console.error(
      `ERROR: IDL not found at ${idlPath}.\n` +
        "  Run `anchor build` first.",
    );
    process.exit(1);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  // Override the IDL's address with the env var so we hit the deployed program.
  idl.address = programId.toBase58();
  const program = new Program(idl, provider);

  // Step 3b: 32-slot mempool buffer wait BEFORE enumeration.
  if (!args.skipSlotWait) {
    console.log("Step 3b: 32-slot mempool buffer");
    console.log("-".repeat(70));
    await waitForMempoolBuffer(connection, 32);
  } else {
    console.log(
      "  --skip-slot-wait set; SKIPPING 32-slot wait. Production runs\n" +
        "  MUST NOT pass this flag — it exists only for offline testing.\n",
    );
  }

  // Enumerate all RedemptionRequest accounts where vault == pool.
  // RedemptionRequest layout: discriminator (8) + investor (32) + vault (32)
  // → vault sits at byte offset 8 + 32 = 40.
  console.log("Enumerating RedemptionRequest PDAs...");
  console.log("-".repeat(70));
  const accounts = await (
    program.account as Record<
      string,
      {
        all: (
          filters: { memcmp: { offset: number; bytes: string } }[],
        ) => Promise<
          {
            publicKey: PublicKey;
            account: {
              investor: PublicKey;
              vault: PublicKey;
              sharesLocked: { toString(): string };
              status: Record<string, unknown>;
            };
          }[]
        >;
      }
    >
  ).redemptionRequest.all([
    {
      memcmp: {
        offset: 8 + 32, // discriminator + investor
        bytes: pool.toBase58(),
      },
    },
  ]);

  console.log(
    `\n  Found ${accounts.length} RedemptionRequest PDA(s) for pool ${pool.toBase58()}\n`,
  );

  let pendingCount = 0;
  for (const a of accounts) {
    const status = Object.keys(a.account.status)[0];
    const pendingMarker = status === "pending" || status === "Pending";
    if (pendingMarker) pendingCount++;

    console.log(
      `  PDA=${a.publicKey.toBase58()}\n` +
        `    investor=${a.account.investor.toBase58()}\n` +
        `    status=${status} shares_locked=${a.account.sharesLocked.toString()}`,
    );

    if (args.cancel && pendingMarker && !args.dryRun) {
      // cancel_redeem requires `investor` as a Signer — see programs/svs-11/
      // src/instructions/cancel_redeem.rs:13. The operator running this
      // script does NOT have authority to cancel another investor's request.
      // Surface this loudly so the runbook step makes the correct decision
      // (coordinate investor self-cancel via UI, or admin-freeze + manual
      // close per plan spec lines 240-241).
      console.log(
        `    NOTE: cancel_redeem requires the investor as Signer; operator\n` +
          `          cannot cancel on their behalf. Coordinate self-cancel\n` +
          `          via the frontend or use admin-freeze + manual close.`,
      );
    }
  }

  console.log(
    "\n" + "─".repeat(70) +
      `\n  Summary: ${pendingCount} pending, ${
        accounts.length - pendingCount
      } non-pending (already settled / cancelled)`,
  );

  if (!args.cancel) {
    console.log(
      "\n  (Read-only mode. Pass --cancel to drain pending requests.\n" +
        "   --dry-run prevents any on-chain writes regardless of --cancel.)",
    );
  }

  if (args.cancel && args.dryRun) {
    console.log(
      "\n  --cancel + --dry-run: enumerated only; no transactions submitted.",
    );
  }

  if (pendingCount > 0) {
    console.log(
      "\n  Next step: coordinate cancellation with affected investors before\n" +
        "  the bundled SVS-11 upgrade runs. Each pending PDA\n" +
        "  in the OLD layout will fail Anchor deserialization post-upgrade.",
    );
  } else {
    console.log(
      "\n  No pending PDAs. Safe to proceed to the bundled SVS-11 upgrade\n" +
        "  once the rest of the pre-flight checklist is green.",
    );
  }

  console.log("\n" + "=".repeat(70) + "\n");
}

main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exit(1);
});
