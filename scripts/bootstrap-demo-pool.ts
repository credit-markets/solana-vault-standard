/**
 * Bootstrap a demo CreditVault pool on devnet.
 *
 * Two on-chain ops, in order:
 *   1. mock_oracle.set_price — creates the oracle data PDA at
 *      [b"oracle", vault] under mock_oracle and seeds an initial price.
 *      The deployed svs-11 reads NAV from mock_oracle today; after the
 *      svs-11 in-place upgrade lands, set_oracle_source(1) flips the
 *      pool to read from nav-oracle instead.
 *   2. svs-11.initialize_pool — creates the CreditVault, shares mint,
 *      deposit ATA, redemption escrow PDAs.
 *
 * After this script: run initialize-nav-account.ts against the same pool
 * PDA to create the parallel NavAccount in nav-oracle (independent of
 * the pool's mock_oracle binding — used by the NAV-publish demo path).
 *
 * Usage:
 *   npx ts-node scripts/bootstrap-demo-pool.ts --dry-run
 *   npx ts-node scripts/bootstrap-demo-pool.ts --execute
 *
 * Override defaults if needed:
 *   --vault-id 2 --min-investment 5000000 --max-staleness 3600
 *   --asset-mint <pubkey> --manager <pubkey> --attester <pubkey>
 *
 * Required env:
 *   SOLANA_DEPLOYER_KEY     path to operator keypair
 *   SOLANA_RPC_URL          optional override (defaults to devnet)
 */
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ─── Constants (devnet) ─────────────────────────────────────────────────────
const SVS11_PROGRAM_ID = new PublicKey(
  "Bf17gDR2JdKTWdoTWK3Va9YQtkpePRAAVxMCaokj8ZFW",
);
const MOCK_ORACLE_PROGRAM_ID = new PublicKey(
  "EbFcZZApkGcX6LqRmzSWVLasnDM457wY4WvhJRnVjdZF",
);
const MOCK_SAS_PROGRAM_ID = new PublicKey(
  "GTTMWDHTZibyEpqNRr33RnBhgms262U6qHaGrjoHqEXg",
);
const USDC_DEVNET = new PublicKey(
  "GAN8FMweFeu2LFNFarggHifiUW8muyGJK8S2dGc6vCTP",
);

// PRICE_SCALE = 1e9 means "1.0 USDC per share" at the oracle's 9-decimal scale.
const INITIAL_PRICE_SCALE = new BN(1_000_000_000);

// PDA seeds — must match the on-chain programs.
const VAULT_SEED = Buffer.from("credit_vault");
const SHARES_MINT_SEED = Buffer.from("shares");
const REDEMPTION_ESCROW_SEED = Buffer.from("redemption_escrow");
const ORACLE_SEED = Buffer.from("oracle");

interface Args {
  isExecute: boolean;
  vaultId: bigint;
  minimumInvestment: bigint;
  maxStaleness: bigint;
  assetMint: PublicKey;
  manager?: PublicKey;
  attester?: PublicKey;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  // Dry-run is default; only --execute disables it.
  const isExecute = argv.includes("--execute");

  let vaultId = 1n;
  let minimumInvestment = 1_000_000n; // 1.0 USDC
  let maxStaleness = 86_400n; // 24h
  let assetMint = USDC_DEVNET;
  let manager: PublicKey | undefined;
  let attester: PublicKey | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case "--vault-id":
        vaultId = BigInt(next);
        i++;
        break;
      case "--min-investment":
        minimumInvestment = BigInt(next);
        i++;
        break;
      case "--max-staleness":
        maxStaleness = BigInt(next);
        i++;
        break;
      case "--asset-mint":
        assetMint = new PublicKey(next);
        i++;
        break;
      case "--manager":
        manager = new PublicKey(next);
        i++;
        break;
      case "--attester":
        attester = new PublicKey(next);
        i++;
        break;
      case "--dry-run":
      case "--execute":
      case undefined:
        break;
      case "--help":
      case "-h":
        printUsageAndExit(0);
        break;
      default:
        if (flag.startsWith("--")) {
          console.error(`Unknown flag: ${flag}`);
          printUsageAndExit(1);
        }
    }
  }

  return {
    isExecute,
    vaultId,
    minimumInvestment,
    maxStaleness,
    assetMint,
    manager,
    attester,
  };
}

function printUsageAndExit(code: number): never {
  console.error(
    `Usage: npx ts-node scripts/bootstrap-demo-pool.ts [--execute]\n\n` +
      `Optional overrides:\n` +
      `  --vault-id <u64>         (default 1)\n` +
      `  --min-investment <u64>   (default 1_000_000 = 1.0 USDC)\n` +
      `  --max-staleness <secs>   (default 86_400 = 24h)\n` +
      `  --asset-mint <pubkey>    (default devnet USDC)\n` +
      `  --manager <pubkey>       (default = operator)\n` +
      `  --attester <pubkey>      (default = operator)\n`,
  );
  process.exit(code);
}

function loadOperator(): Keypair {
  const keyPath = process.env.SOLANA_DEPLOYER_KEY;
  if (!keyPath) throw new Error("SOLANA_DEPLOYER_KEY env var is required");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf-8"))),
  );
}

async function main() {
  const args = parseArgs();
  const conn = new Connection(
    process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    "confirmed",
  );
  const operator = loadOperator();
  const manager = args.manager ?? operator.publicKey;
  const attester = args.attester ?? operator.publicKey;

  // ── Derive all PDAs off-chain ─────────────────────────────────────────────
  const vaultIdBuf = Buffer.alloc(8);
  vaultIdBuf.writeBigUInt64LE(args.vaultId);

  const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, args.assetMint.toBuffer(), vaultIdBuf],
    SVS11_PROGRAM_ID,
  );
  const [sharesMintPda] = PublicKey.findProgramAddressSync(
    [SHARES_MINT_SEED, vaultPda.toBuffer()],
    SVS11_PROGRAM_ID,
  );
  const [redemptionEscrowPda] = PublicKey.findProgramAddressSync(
    [REDEMPTION_ESCROW_SEED, vaultPda.toBuffer()],
    SVS11_PROGRAM_ID,
  );
  // mock_oracle data PDA: matches the convention in svs-11.ts tests.
  const [oracleDataPda] = PublicKey.findProgramAddressSync(
    [ORACLE_SEED, vaultPda.toBuffer()],
    MOCK_ORACLE_PROGRAM_ID,
  );
  // deposit_vault is an ATA owned by the vault PDA — derive via spl helper.
  const depositVaultAta = getAssociatedTokenAddressSync(
    args.assetMint,
    vaultPda,
    /* allowOwnerOffCurve */ true,
    TOKEN_PROGRAM_ID,
  );

  // Future NavAccount PDA (under nav-oracle program) so the operator
  // can run initialize-nav-account.ts as the next step.
  const NAV_ORACLE_PROGRAM_ID = new PublicKey(
    "7564bvScA3FjQ9w5nCx44EK4JkgitzZ3UstX1e4eKks7",
  );
  const [navAccountPdaForReference] = PublicKey.findProgramAddressSync(
    [Buffer.from("nav_oracle"), vaultPda.toBuffer()],
    NAV_ORACLE_PROGRAM_ID,
  );

  console.log(`\n=== bootstrap-demo-pool ===`);
  console.log(
    `Mode:                 ${args.isExecute ? "EXECUTE" : "DRY-RUN (default)"}`,
  );
  console.log(`Operator:             ${operator.publicKey.toBase58()}`);
  console.log(`\n── Pool params ───`);
  console.log(`  vault_id:           ${args.vaultId}`);
  console.log(`  minimum_investment: ${args.minimumInvestment} (raw u64)`);
  console.log(`  max_staleness:      ${args.maxStaleness}s`);
  console.log(`  manager:            ${manager.toBase58()}`);
  console.log(`  attester:           ${attester.toBase58()}`);
  console.log(`  asset_mint:         ${args.assetMint.toBase58()}`);
  console.log(`\n── Derived PDAs ───`);
  console.log(`  vault (CreditVault): ${vaultPda.toBase58()} (bump=${vaultBump})`);
  console.log(`  shares_mint:        ${sharesMintPda.toBase58()}`);
  console.log(`  redemption_escrow:  ${redemptionEscrowPda.toBase58()}`);
  console.log(`  deposit_vault ATA:  ${depositVaultAta.toBase58()}`);
  console.log(`  oracle_data (mock): ${oracleDataPda.toBase58()}`);
  console.log(
    `  nav_account (FUTURE): ${navAccountPdaForReference.toBase58()}`,
  );
  console.log(`\n── Programs ───`);
  console.log(`  svs-11:             ${SVS11_PROGRAM_ID.toBase58()}`);
  console.log(`  mock_oracle:        ${MOCK_ORACLE_PROGRAM_ID.toBase58()}`);
  console.log(`  mock_sas:           ${MOCK_SAS_PROGRAM_ID.toBase58()}`);

  // ── Pre-flight: ensure pool doesn't already exist ─────────────────────────
  const existingVault = await conn.getAccountInfo(vaultPda);
  if (existingVault) {
    console.log(
      `\n⚠️  Pool already exists at ${vaultPda.toBase58()} (${existingVault.data.length} bytes).`,
    );
    console.log(
      `   To create a different pool, pass --vault-id with a fresh u64.`,
    );
    if (!args.isExecute) return;
    process.exit(1);
  }

  if (!args.isExecute) {
    console.log(`\n✅ Dry-run complete. Re-run with --execute to apply.`);
    console.log(
      `\n   Next: after pool creation, run initialize-nav-account.ts:`,
    );
    console.log(`     export NAV_ORACLE_PROGRAM_ID=${NAV_ORACLE_PROGRAM_ID.toBase58()}`);
    console.log(
      `     npx ts-node scripts/initialize-nav-account.ts \\\n       --pool ${vaultPda.toBase58()} \\\n       --publisher <NAV_PUBLISHER_PUBKEY> \\\n       --rotation-authority ${operator.publicKey.toBase58()}`,
    );
    return;
  }

  // ── Execute path ──────────────────────────────────────────────────────────
  // 1) Initialize mock_oracle data PDA with initial price.
  const mockIdl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "target", "idl", "mock_oracle.json"),
      "utf-8",
    ),
  );
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
  const mockOracleProgram = new Program(mockIdl as any, provider);

  console.log(`\n[1/2] Initializing mock_oracle data PDA + setting price...`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setPriceSig = await (mockOracleProgram.methods as any)
    .setPrice(INITIAL_PRICE_SCALE)
    .accountsPartial({
      authority: operator.publicKey,
      oracleData: oracleDataPda,
      vault: vaultPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`      ✅ mock_oracle.set_price: ${setPriceSig}`);

  // 2) Initialize the SVS-11 pool.
  const svsIdl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "target", "idl", "svs_11.json"),
      "utf-8",
    ),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svsProgram = new Program(svsIdl as any, provider);

  console.log(`\n[2/2] Initializing SVS-11 pool...`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initPoolSig = await (svsProgram.methods as any)
    .initializePool(
      new BN(args.vaultId.toString()),
      new BN(args.minimumInvestment.toString()),
      new BN(args.maxStaleness.toString()),
    )
    .accountsPartial({
      authority: operator.publicKey,
      manager,
      vault: vaultPda,
      assetMint: args.assetMint,
      sharesMint: sharesMintPda,
      depositVault: depositVaultAta,
      redemptionEscrow: redemptionEscrowPda,
      navOracle: oracleDataPda,
      oracleProgram: MOCK_ORACLE_PROGRAM_ID,
      attester,
      attestationProgram: MOCK_SAS_PROGRAM_ID,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log(`      ✅ svs-11.initialize_pool: ${initPoolSig}`);

  // ── Persist artifacts ─────────────────────────────────────────────────────
  const outFile = path.resolve(`.demo-pool-${args.vaultId}.json`);
  const artifact = {
    cluster: "devnet",
    created_at: new Date().toISOString(),
    vault_id: args.vaultId.toString(),
    pool: vaultPda.toBase58(),
    shares_mint: sharesMintPda.toBase58(),
    deposit_vault_ata: depositVaultAta.toBase58(),
    redemption_escrow: redemptionEscrowPda.toBase58(),
    oracle_data_mock: oracleDataPda.toBase58(),
    nav_account_future: navAccountPdaForReference.toBase58(),
    asset_mint: args.assetMint.toBase58(),
    manager: manager.toBase58(),
    attester: attester.toBase58(),
    minimum_investment: args.minimumInvestment.toString(),
    max_staleness: args.maxStaleness.toString(),
    initial_price_scale: INITIAL_PRICE_SCALE.toString(),
    set_price_tx: setPriceSig,
    initialize_pool_tx: initPoolSig,
    next_steps: [
      "Run initialize-nav-account.ts to create the parallel NavAccount under nav-oracle",
      "After svs-11 in-place upgrade: run realloc_credit_vault_for_oracle_v2 + set_oracle_source(1) to flip read-path to nav-oracle",
    ],
  };
  fs.writeFileSync(outFile, JSON.stringify(artifact, null, 2));
  console.log(`\n📋 Pool artifacts written to ${outFile}`);
  console.log(
    `\nNext: npx ts-node scripts/initialize-nav-account.ts --pool ${vaultPda.toBase58()} --publisher <PUB> --rotation-authority ${operator.publicKey.toBase58()}`,
  );
}

main().catch((e) => {
  console.error(`\n❌ bootstrap-demo-pool failed:`);
  console.error(e);
  process.exit(1);
});
