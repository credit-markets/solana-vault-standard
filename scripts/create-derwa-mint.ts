/**
 * Create dePOOL Mint Script.
 *
 * Creates a per-pool dePOOL Token-2022 mint with the ComplianceHook
 * bound at the Token-2022 extension level. The resulting mint pubkey
 * is the input to `wrapper.initialize()`.
 *
 * Why this exists: the wrapper code references `derwa_mint` as if it
 * already exists with a FreelyTransferable hook binding, but nothing
 * else creates it. Without this script, `wrap` and `unwrap` would
 * either fail with "mint not found" OR worse, succeed silently against
 * a mint that has NO compliance hook (sanctions checks bypassed).
 *
 * ─── KNOWN GAP — MintConfig + ExtraAccountMetaList init DEFERRED to runbook ──
 *
 * The original design called this script to also CPI into
 * compliance-hook to:
 *   (a) create the MintConfig PDA with mode=FreelyTransferable
 *   (b) create the ExtraAccountMetaList PDA at [b"extra-account-metas", mint]
 *
 * BUT: compliance-hook does NOT expose an `initialize_mint_config`
 * instruction (only `initialize_sanctions_list`,
 * `initialize_extra_account_meta_list`, `update_sanctions_list`,
 * `execute` are public per
 * programs/programs/compliance-hook/src/lib.rs). And
 * `initialize_extra_account_meta_list` REQUIRES `MintConfig` to already
 * exist (typed `Account<'info, MintConfig>` constraint at
 * programs/programs/compliance-hook/src/instructions/initialize_extra_account_meta_list.rs:52-57).
 *
 * Resolution: defer (a) and (b) to the deployment runbook. Until
 * compliance-hook grows a public `initialize_mint_config` ix, this
 * script:
 *
 *   ✅ DOES create the Token-2022 mint with TransferHook extension
 *      binding (extension authority = operator; should be rotated to
 *      Ops Guardian post-deploy)
 *   ✅ DOES set wrapper_signer PDA as mint + freeze authority (only
 *      the derwa-wrapper program can mint/burn dePOOL)
 *   ✅ DOES persist the artifact JSON with `pending_runbook_steps` so
 *      downstream tasks see the gap explicitly
 *   ❌ DOES NOT call initializeMintConfig (ix does not exist)
 *   ❌ DOES NOT call initializeExtraAccountMetaList (would fail without
 *      MintConfig)
 *
 * The artifact JSON includes a `pending_runbook_steps` array
 * enumerating the remaining work for the operator. The deployment
 * runbook must enumerate these as named steps before this is
 * considered fully closed.
 *
 * Usage:
 *   npx ts-node scripts/create-derwa-mint.ts \
 *     --pool <CreditVault-PDA> \
 *     [--cluster devnet]
 *
 * Required env:
 *   COMPLIANCE_HOOK_PROGRAM_ID  — devnet compliance-hook program ID
 *   DERWA_WRAPPER_PROGRAM_ID    — devnet derwa-wrapper program ID
 *   SOLANA_DEPLOYER_KEY         — operator keypair path (defaults to
 *                                 ANCHOR_WALLET → ~/.config/solana/id.json)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  getMintLen,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ─── CLI parsing ────────────────────────────────────────────────────────────
//
// Convention: match drain-redemption-requests.ts's hand-rolled loop parser
// (yargs is not in package.json deps; the spec's yargs example is illustrative
// only — the repo uses vanilla process.argv parsing).

interface Args {
  pool: string;
  cluster: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let pool: string | undefined;
  let cluster = "devnet";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--pool" && next) {
      pool = next;
      i++;
    } else if (a === "--cluster" && next) {
      cluster = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      printUsageAndExit(0);
    } else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      printUsageAndExit(1);
    }
  }

  if (!pool) {
    console.error("Missing required --pool <CreditVault-PDA>");
    printUsageAndExit(1);
  }

  return { pool: pool!, cluster };
}

function printUsageAndExit(code: number): never {
  console.error(
    `Usage:\n  npx ts-node scripts/create-derwa-mint.ts --pool <CreditVault-PDA> [--cluster devnet]\n\nRequired env:\n  COMPLIANCE_HOOK_PROGRAM_ID, DERWA_WRAPPER_PROGRAM_ID, SOLANA_DEPLOYER_KEY (or ANCHOR_WALLET)\n`,
  );
  process.exit(code);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadOperatorKeypair(): Keypair {
  const keyPath =
    process.env.SOLANA_DEPLOYER_KEY ??
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config", "solana", "id.json");

  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Operator keypair not found at ${keyPath}. Set SOLANA_DEPLOYER_KEY or ANCHOR_WALLET.`,
    );
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf-8"))),
  );
}

function rpcUrlForCluster(cluster: string): string {
  if (cluster === "localhost" || cluster === "localnet") {
    return "http://127.0.0.1:8899";
  }
  return clusterApiUrl(cluster as "devnet" | "testnet" | "mainnet-beta");
}

function requireEnvPubkey(name: string): PublicKey {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var ${name}`);
  }
  try {
    return new PublicKey(v);
  } catch (err) {
    throw new Error(`Env var ${name} is not a valid pubkey: ${v}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const conn = new Connection(rpcUrlForCluster(args.cluster), "confirmed");
  const operator = loadOperatorKeypair();

  const pool = new PublicKey(args.pool);
  const COMPLIANCE_HOOK = requireEnvPubkey("COMPLIANCE_HOOK_PROGRAM_ID");
  const DERWA_WRAPPER = requireEnvPubkey("DERWA_WRAPPER_PROGRAM_ID");

  console.log(`\n=== Create dePOOL Mint ===`);
  console.log(`Cluster:           ${args.cluster}`);
  console.log(`Pool:              ${pool.toBase58()}`);
  console.log(`ComplianceHook:    ${COMPLIANCE_HOOK.toBase58()}`);
  console.log(`DerwaWrapper:      ${DERWA_WRAPPER.toBase58()}`);
  console.log(`Operator:          ${operator.publicKey.toBase58()}\n`);

  // 1. Generate the mint keypair (the dePOOL mint address is its public key).
  const mintKp = Keypair.generate();
  console.log(`dePOOL mint will be: ${mintKp.publicKey.toBase58()}`);

  // 2. Derive the wrapper signer PDA: seed = [b"wrapper_signer", pool].
  //    This becomes mint+freeze authority, ensuring only the derwa-wrapper
  //    program can mint/burn dePOOL. The seed string MUST match the wrapper
  //    program's signer derivation in state.rs.
  const [wrapperSigner, wrapperSignerBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("wrapper_signer"), pool.toBuffer()],
    DERWA_WRAPPER,
  );
  console.log(
    `Wrapper signer PDA: ${wrapperSigner.toBase58()} (bump=${wrapperSignerBump})`,
  );

  // 3. Compute mint account size for Token-2022 + TransferHook extension.
  //    `getMintLen` adds the TLV-encoded extension space on top of the base
  //    mint state size, so the account is correctly sized at create time
  //    (Token-2022 cannot grow a mint account post-init).
  const mintLen = getMintLen([ExtensionType.TransferHook]);
  const mintRent = await conn.getMinimumBalanceForRentExemption(mintLen);

  const ixs: TransactionInstruction[] = [
    // a. Create the mint account (rent + space for Token-2022 + TransferHook)
    SystemProgram.createAccount({
      fromPubkey: operator.publicKey,
      newAccountPubkey: mintKp.publicKey,
      lamports: mintRent,
      space: mintLen,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // b. Initialize the TransferHook extension pointing at compliance-hook.
    //    The extension AUTHORITY (= operator here) can later rotate the hook
    //    program ID. Plan A's deployment runbook rotates this to the Ops
    //    Guardian Squads vault post-test (so a single-key compromise can't
    //    swap the hook program at runtime). Setting the extension MUST
    //    happen BEFORE InitializeMint or Token-2022 rejects it (per the
    //    Token-2022 spec: extensions are configured pre-init).
    createInitializeTransferHookInstruction(
      mintKp.publicKey,
      operator.publicKey, // extension authority — rotated to Ops Guardian post-test (runbook)
      COMPLIANCE_HOOK, // hook program — compliance-hook from Plan A
      TOKEN_2022_PROGRAM_ID,
    ),
    // c. Initialize the mint itself with the wrapper_signer PDA as both
    //    mint authority and freeze authority. This is the lock that ensures
    //    only the wrapper program can mint/burn dePOOL — even the operator
    //    cannot touch supply post-init.
    //
    //    Decimals = 6: matches cPOOL's default decimals from
    //    (`initialize_pool` defaults `permissioned_mint.decimals = 6`).
    //    Wrap/unwrap is 1:1 between cPOOL and dePOOL, so the decimals MUST
    //    match exactly — any mismatch breaks the wrap math.
    createInitializeMintInstruction(
      mintKp.publicKey,
      6,
      wrapperSigner,
      wrapperSigner,
      TOKEN_2022_PROGRAM_ID,
    ),
  ];

  console.log(`\nSubmitting mint creation tx...`);
  const sig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(...ixs),
    [operator, mintKp],
  );
  console.log(`✅ dePOOL Token-2022 mint created`);
  console.log(`   tx: ${sig}`);
  console.log(
    `   TransferHook → ${COMPLIANCE_HOOK.toBase58()} (extension authority: operator, rotate post-deploy)`,
  );

  // 4. ── DEFERRED: MintConfig PDA creation ──────────────────────────────────
  //    The original spec's Step 4 called compliance_hook::initializeMintConfig
  //    here, but that instruction does NOT exist in compliance-hook (see
  //    KNOWN GAP at file header). Skipped — see runbook below.
  const [mintConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_config"), mintKp.publicKey.toBuffer()],
    COMPLIANCE_HOOK,
  );

  // 5. ── DEFERRED: ExtraAccountMetaList PDA creation ───────────────────────
  //    Original spec's Step 5. Cannot run until MintConfig exists (typed
  //    Account<'info, MintConfig> constraint in the ix). Skipped — see
  //    runbook below.
  const [emaListPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mintKp.publicKey.toBuffer()],
    COMPLIANCE_HOOK,
  );

  // 6. Persist the artifact JSON for downstream consumers (Task 6 wrapper
  //    init + Task 14 runbook). The `pending_runbook_steps` array makes the
  //    deferral explicit so a future operator/agent can't accidentally
  //    treat this as fully wired-up.
  const outFile = path.resolve(`.derwa-mints-${pool.toBase58()}.json`);
  const artifact = {
    plan: "C",
    task: "5b",
    cluster: args.cluster,
    pool: pool.toBase58(),
    derwa_mint: mintKp.publicKey.toBase58(),
    mint_config: mintConfigPda.toBase58(),
    extra_account_meta_list: emaListPda.toBase58(),
    wrapper_signer: wrapperSigner.toBase58(),
    wrapper_signer_bump: wrapperSignerBump,
    compliance_hook_program_id: COMPLIANCE_HOOK.toBase58(),
    derwa_wrapper_program_id: DERWA_WRAPPER.toBase58(),
    decimals: 6,
    transfer_hook_extension_authority: operator.publicKey.toBase58(),
    created_at: new Date().toISOString(),
    creation_tx: sig,
    // Explicit deferral — DO NOT remove without confirming the gap closed.
    pending_runbook_steps: [
      "MintConfig PDA creation (mode=FreelyTransferable, pool_policy=None) — blocked: compliance-hook lacks public initialize_mint_config ix; see deployment runbook",
      "ExtraAccountMetaList PDA initialization at [b'extra-account-metas', derwa_mint] — blocked: depends on MintConfig",
      "Rotate TransferHook extension authority from operator to Ops Guardian Squads vault — Plan A deployment runbook",
    ],
    fully_wired: false,
  };

  fs.writeFileSync(outFile, JSON.stringify(artifact, null, 2));
  console.log(`\nWrote dePOOL artifacts → ${outFile}`);

  // 7. Loud, unmissable warning — operator MUST run runbook steps before
  //    Task 6 wrapper init can succeed end-to-end against compliance-hook.
  console.log(`\n${"━".repeat(72)}`);
  console.log(
    `⚠️  PARTIAL COMPLETION — runbook steps required before wrap/unwrap will work:`,
  );
  console.log(`${"━".repeat(72)}`);
  for (const step of artifact.pending_runbook_steps) {
    console.log(`   • ${step}`);
  }
  console.log(`${"━".repeat(72)}`);
  console.log(
    `\nNext: pass derwa_mint=${mintKp.publicKey.toBase58()} to wrapper.initialize.\n`,
  );
}

main().catch((e) => {
  console.error(`\n❌ create-derwa-mint failed:`);
  console.error(e);
  process.exit(1);
});
