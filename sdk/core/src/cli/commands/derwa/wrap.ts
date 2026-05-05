/** derwa wrap — wrap cPOOL to dePOOL (1:1) */

import { Command } from "commander";
import { BN, Program } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { DeRwaWrapper } from "../../../derwa-wrapper";
import { loadIdl } from "../../utils";

export function registerWrapCommand(parent: Command): void {
  parent
    .command("wrap")
    .description("Wrap cPOOL into dePOOL 1:1 (caller signs as cPOOL holder)")
    .requiredOption("--amount <u64>", "Amount of cPOOL to wrap (raw u64)")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      const idlPath = path.resolve(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "target",
        "idl",
        "derwa_wrapper.json",
      );
      if (!fs.existsSync(idlPath)) {
        output.error(
          "derwa-wrapper IDL not found. Run `anchor build -p derwa_wrapper` first.",
        );
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const amount = new BN(opts.amount);

        output.info("═══ deRWA Wrapper: Wrap ═══");
        output.info(`  User:    ${wallet.publicKey.toBase58()}`);
        output.info(`  Amount:  ${amount.toString()} cPOOL → dePOOL`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm("Proceed?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Wrapping cPOOL → dePOOL...");
        spinner.start();

        const sig = await DeRwaWrapper.wrap(prog, wallet.publicKey, {
          user: wallet.publicKey,
          amount,
        });

        spinner.succeed(`Wrapped ${amount.toString()} cPOOL → dePOOL`);
        output.success(`Tx: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            user: wallet.publicKey.toBase58(),
            amount: amount.toString(),
            signature: sig,
          });
        }
      } catch (error) {
        output.error(
          `Wrap failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
