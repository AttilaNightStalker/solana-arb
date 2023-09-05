import * as anchor from "@coral-xyz/anchor";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  AutoUpdateAccountWithData,
  DexSimulation,
  PoolSimulationParams,
  parsedDexConfig,
} from "./base";
import { PathLike, readFileSync } from "fs";
import {
  TICK_ARRAY_SIZE,
  TickArray,
  TickArrayData,
  WhirlpoolData,
  swapQuoteWithParams,
} from "@orca-so/whirlpools-sdk";
import WhirlpoolIdl from "../idl/whirlpool.json";
import { Idl } from "@coral-xyz/anchor";
import { Percentage } from "@orca-so/common-sdk";
import Decimal from "decimal.js";
import { WalletWithTokenMap, getProgram, tickArrayKeyByIndex } from "../utils";
import { ArbProgram, ArbSwapStatePDA } from "../singletons";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { TickArrayPDASet } from "../types";

interface OrcaWhirpoolConfig {
  pool: string;
  tokenA: string;
  tokenB: string;
  tokenVaultA: string;
  tokenVaultB: string;
  oracle: string;
}

interface OrcaDexConfig {
  programAddress: string;
  pools: OrcaWhirpoolConfig[];
}

export class OrcaDexSimulation extends DexSimulation {
  static getTickArrayIndicesFunc(whirlpoolData: WhirlpoolData, aToB: boolean = true) {
    const { tickCurrentIndex, tickSpacing } = whirlpoolData;
    const tickArrayTargetIndex = aToB ? tickCurrentIndex : tickCurrentIndex + tickSpacing;
    const fullTickArraySize = TICK_ARRAY_SIZE * tickSpacing;
    let curTickOffset = tickArrayTargetIndex % fullTickArraySize;
    if (curTickOffset < 0) {
      curTickOffset += fullTickArraySize;
    }
    const curTickArrayStartIndex = tickArrayTargetIndex - curTickOffset;
    return (arrayOffset: number) => curTickArrayStartIndex + fullTickArraySize * arrayOffset;
  }

  static getTickArrayPDA(
    programId: PublicKey,
    whirlPoolAddress: PublicKey,
    tickArrayStartIndex: number,
  ) {
    const [tickArrayPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("tick_array"),
        whirlPoolAddress.toBuffer(),
        Buffer.from(tickArrayStartIndex.toString()),
      ],
      programId,
    );
    return tickArrayPDA;
  }

  static getWhirlPoolTickArrays(
    programId: PublicKey,
    whirlpoolAcountWithData: AutoUpdateAccountWithData<WhirlpoolData>,
    aToB: boolean = true,
  ): TickArrayPDASet {
    const tickArrayIndexFunc = OrcaDexSimulation.getTickArrayIndicesFunc(
      whirlpoolAcountWithData.get(),
      aToB,
    );

    return {
      curTickArray: OrcaDexSimulation.getTickArrayPDA(
        programId,
        whirlpoolAcountWithData.address,
        tickArrayIndexFunc(0),
      ),
      skipPrevTickArrayIndex: OrcaDexSimulation.getTickArrayPDA(
        programId,
        whirlpoolAcountWithData.address,
        tickArrayIndexFunc(-2),
      ),
      prevTickArrayIndex: OrcaDexSimulation.getTickArrayPDA(
        programId,
        whirlpoolAcountWithData.address,
        tickArrayIndexFunc(-1),
      ),
      nextTickArrayIndex: OrcaDexSimulation.getTickArrayPDA(
        programId,
        whirlpoolAcountWithData.address,
        tickArrayIndexFunc(1),
      ),
      skipNextTickArrayIndex: OrcaDexSimulation.getTickArrayPDA(
        programId,
        whirlpoolAcountWithData.address,
        tickArrayIndexFunc(2),
      ),
    };
  }

  protected loadAndInitializeDexConfig(dexConfigPath: PathLike): parsedDexConfig {
    this.constantWatchingAccount = [];

    const orcaDexConfig: OrcaDexConfig = JSON.parse(readFileSync(dexConfigPath).toString());
    let poolSimulationParamsList: PoolSimulationParams[] = [];
    const programPubkey = new PublicKey(orcaDexConfig.programAddress);
    const orcaProgram = getProgram(WhirlpoolIdl as Idl, programPubkey);

    const whirlpoolDecoder = (dataBuffer: Buffer) =>
      orcaProgram.account.whirlpool.coder.accounts.decode("Whirlpool", dataBuffer);
    const tickArrayDecoder = (dataBuffer: Buffer) =>
      orcaProgram.account.tickArray.coder.accounts.decode("TickArray", dataBuffer);

    for (const poolConfig of orcaDexConfig.pools) {
      const poolSimulation: PoolSimulationParams = {
        programId: programPubkey,
        pool: new AutoUpdateAccountWithData<WhirlpoolData>(
          new PublicKey(poolConfig.pool),
          this.connection,
          whirlpoolDecoder,
        ),
        tokenA: poolConfig.tokenA,
        tokenB: poolConfig.tokenB,
        watchedPoolAccounts: {},
        txPoolAccounts: {
          tokenVaultA: new PublicKey(poolConfig.tokenVaultA),
          tokenVaultB: new PublicKey(poolConfig.tokenVaultB),
          oracle: new PublicKey(poolConfig.oracle),
        },
      };

      const connection = this.connection;
      poolSimulation.pool.registerOnUpdate(async () => {
        const tickArrayIndexFunc = OrcaDexSimulation.getTickArrayIndicesFunc(
          (poolSimulation.pool as AutoUpdateAccountWithData<WhirlpoolData>).get(),
        );
        const promiseList = [];
        for (const index of [
          tickArrayIndexFunc(-1),
          tickArrayIndexFunc(0),
          tickArrayIndexFunc(1),
        ]) {
          const tickArrayKey = tickArrayKeyByIndex(index);
          if (!poolSimulation.watchedPoolAccounts[tickArrayKey]) {
            poolSimulation.watchedPoolAccounts[tickArrayKey] =
              new AutoUpdateAccountWithData<TickArrayData>(
                OrcaDexSimulation.getTickArrayPDA(
                  programPubkey,
                  poolSimulation.pool.address,
                  index,
                ),
                connection,
                tickArrayDecoder,
              );
            promiseList.push(poolSimulation.watchedPoolAccounts[tickArrayKey].start());
          }
        }

        for (const index of [tickArrayIndexFunc(-2), tickArrayIndexFunc(2)]) {
          const tickArrayKey = tickArrayKeyByIndex(index);
          if (!!poolSimulation.watchedPoolAccounts[tickArrayKey]) {
            promiseList.push(
              poolSimulation.watchedPoolAccounts[tickArrayKey].stop().then(() => {
                poolSimulation.watchedPoolAccounts[tickArrayKey] = null;
              }),
            );
          }
        }
        await Promise.all(promiseList);
      });

      poolSimulationParamsList.push(poolSimulation);
    }

    return {
      programId: programPubkey,
      poolSimulationParamsList,
    };
  }

  protected poolSimuluationGetAmountOut(
    poolSimulationParams: PoolSimulationParams,
    inAmount: anchor.BN,
    aToB: boolean,
  ): anchor.BN {
    const sqrtPriceLimit = aToB
      ? new anchor.BN("4295048016")
      : new anchor.BN("79226673515401279992447579055");

    const { pool, watchedPoolAccounts, programId } = poolSimulationParams;
    const whirlpoolData = (pool as AutoUpdateAccountWithData<WhirlpoolData>).get();

    const tickArrayIndexFunc = OrcaDexSimulation.getTickArrayIndicesFunc(
      (poolSimulationParams.pool as AutoUpdateAccountWithData<WhirlpoolData>).get(),
      aToB,
    );

    const tickArrayKey = tickArrayKeyByIndex(tickArrayIndexFunc(0));
    const tickArrays = (
      aToB
        ? [
            watchedPoolAccounts[tickArrayKey],
            watchedPoolAccounts[tickArrayKeyByIndex(tickArrayIndexFunc(-1))] ||
              watchedPoolAccounts[tickArrayKey],
            watchedPoolAccounts[tickArrayKeyByIndex(tickArrayIndexFunc(-1))] ||
              watchedPoolAccounts[tickArrayKey],
          ]
        : [
            watchedPoolAccounts[tickArrayKey],
            watchedPoolAccounts[tickArrayKeyByIndex(tickArrayIndexFunc(1))] ||
              watchedPoolAccounts[tickArrayKey],
            watchedPoolAccounts[tickArrayKeyByIndex(tickArrayIndexFunc(1))] ||
              watchedPoolAccounts[tickArrayKey],
          ]
    ).map(
      (tickArrayAccount: AutoUpdateAccountWithData<TickArrayData>): TickArray => ({
        data: tickArrayAccount.get(),
        address: tickArrayAccount.address,
      }),
    );

    const swapQuote = swapQuoteWithParams(
      {
        whirlpoolData,
        tokenAmount: inAmount,
        otherAmountThreshold: new anchor.BN(0),
        sqrtPriceLimit,
        aToB,
        amountSpecifiedIsInput: true,
        tickArrays,
      },
      Percentage.fromDecimal(new Decimal(100)),
    );

    return swapQuote.estimatedAmountOut;
  }

  protected async poolSimulationArbInstruction(
    poolSimulationParams: PoolSimulationParams,
    aToB: boolean,
    payer: WalletWithTokenMap,
  ): Promise<TransactionInstruction> {
    const arbProgram = ArbProgram.getInstance();
    const { pool, tokenA, tokenB, watchedPoolAccounts, txPoolAccounts } = poolSimulationParams;
    const poolData = (pool as AutoUpdateAccountWithData<WhirlpoolData>).get();

    const tickArrayIndexFunc = OrcaDexSimulation.getTickArrayIndicesFunc(poolData, aToB);

    const tickArrayKey = tickArrayKeyByIndex(tickArrayIndexFunc(0));
    const nextTickArrayKey = tickArrayKeyByIndex(tickArrayIndexFunc(1));

    return arbProgram.methods
      .orcaSwap(aToB)
      .accounts({
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenAuthority: payer.publicKey,
        whirlpool: pool.address,
        tokenOwnerAccountA: payer.getTokenAccountPubkey(tokenA),
        tokenVaultA: txPoolAccounts["tokenVaultA"],
        tokenOwnerAccountB: payer.getTokenAccountPubkey(tokenB),
        tokenVaultB: txPoolAccounts["tokenVaultB"],
        tickArray0: watchedPoolAccounts[tickArrayKey].address,
        tickArray1:
          watchedPoolAccounts[nextTickArrayKey]?.address ||
          watchedPoolAccounts[tickArrayKey].address,
        tickArray2:
          watchedPoolAccounts[nextTickArrayKey]?.address ||
          watchedPoolAccounts[tickArrayKey].address,
        oracle: txPoolAccounts["oracle"],
        swapState: ArbSwapStatePDA.getInstance(),
        orcaSwapProgram: poolSimulationParams.programId,
      })
      .instruction();
  }
}
