import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
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
import WhirlpoolIdl from "../../idl/whirlpool.json";
import { Idl } from "@coral-xyz/anchor";
import { Percentage } from "@orca-so/common-sdk";
import Decimal from "decimal.js";
import { WalletWithTokenMap, getProgram, tickArrayKeyByIndex } from "../utils";
import { ArbProgram, ArbSwapStatePDA } from "../singletons";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { TickArrayPDASet } from "../types";
import { ConnectionPool } from "../connectionPool";

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
  readonly name = "orca";

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
    // const tickArrayDecoder = (dataBuffer: Buffer) =>
    //   orcaProgram.account.tickArray.coder.accounts.decode("TickArray", dataBuffer);

    for (const poolConfig of orcaDexConfig.pools) {
      const poolSimulation: PoolSimulationParams = {
        programId: programPubkey,
        pool: new AutoUpdateAccountWithData<WhirlpoolData>(
          new PublicKey(poolConfig.pool),
          this.connectionPool,
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

      poolSimulationParamsList.push(poolSimulation);
    }

    return {
      programId: programPubkey,
      poolSimulationParamsList,
    };
  }

  public async preCalculationUpdate(
    connectionPool: ConnectionPool,
    poolSimulationParams: PoolSimulationParams,
    aToB: boolean,
  ): Promise<PoolSimulationParams> {
    const { programId, watchedPoolAccounts, pool } = poolSimulationParams;
    const tickArrayIndexFunc = OrcaDexSimulation.getTickArrayIndicesFunc(
      (poolSimulationParams.pool as AutoUpdateAccountWithData<WhirlpoolData>).get(),
      aToB,
    );

    const tickArrayStartIndexList = aToB
      ? [tickArrayIndexFunc(0), tickArrayIndexFunc(-1), tickArrayIndexFunc(-2)]
      : [tickArrayIndexFunc(0), tickArrayIndexFunc(1), tickArrayIndexFunc(2)];

    const orcaProgram = getProgram(WhirlpoolIdl as Idl, programId);
    const tickArrayDecoder = (dataBuffer: Buffer) =>
      orcaProgram.account.tickArray.coder.accounts.decode("TickArray", dataBuffer) as TickArrayData;

    await Promise.all(
      tickArrayStartIndexList.map(async (startIndex: number) => {
        const tickArrayKey = tickArrayKeyByIndex(startIndex);
        const tickArrayAddress = OrcaDexSimulation.getTickArrayPDA(
          programId,
          pool.address,
          startIndex,
        );
        if (!watchedPoolAccounts[tickArrayKey]) {
          watchedPoolAccounts[tickArrayKey] = new AutoUpdateAccountWithData<TickArray>(
            tickArrayAddress,
            connectionPool,
            (data: Buffer) => ({
              data: tickArrayDecoder(data),
              address: tickArrayAddress,
            }),
          );
        }
        const tickArrayPoolAccounts = watchedPoolAccounts[
          tickArrayKey
        ] as AutoUpdateAccountWithData<TickArray>;
        await tickArrayPoolAccounts.update();
      }),
    );

    return poolSimulationParams;
  }

  private static poolSimuluationGetAmountOutInternal(
    poolSimulationParams: PoolSimulationParams,
    inAmount: anchor.BN,
    aToB: boolean,
  ): anchor.BN {
    const sqrtPriceLimit = aToB
      ? new anchor.BN("4295048016")
      : new anchor.BN("79226673515401279992447579055");

    const { pool, programId, watchedPoolAccounts } = poolSimulationParams;
    const whirlpoolData = (pool as AutoUpdateAccountWithData<WhirlpoolData>).get();

    const tickArrayIndexFunc = OrcaDexSimulation.getTickArrayIndicesFunc(
      (poolSimulationParams.pool as AutoUpdateAccountWithData<WhirlpoolData>).get(),
      aToB,
    );

    const tickArrayStartIndexList = aToB
      ? [tickArrayIndexFunc(0), tickArrayIndexFunc(-1), tickArrayIndexFunc(-2)]
      : [tickArrayIndexFunc(0), tickArrayIndexFunc(1), tickArrayIndexFunc(2)];

    const tickArrays = tickArrayStartIndexList.map((startIndex) => {
      const tickArrayKey = tickArrayKeyByIndex(startIndex);
      return (watchedPoolAccounts[tickArrayKey] as AutoUpdateAccountWithData<TickArray>).get();
    });

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

  protected poolSimuluationGetAmountOut(
    poolSimulationParams: PoolSimulationParams,
    inAmount: anchor.BN,
    aToB: boolean,
  ): anchor.BN {
    return DexSimulation.outZeroOnFailure(
      poolSimulationParams,
      inAmount,
      aToB,
      OrcaDexSimulation.poolSimuluationGetAmountOutInternal,
    );
  }

  protected async poolSimulationArbInstruction(
    poolSimulationParams: PoolSimulationParams,
    aToB: boolean,
    payer: WalletWithTokenMap,
  ): Promise<TransactionInstruction> {
    const arbProgram = ArbProgram.getInstance();
    const { programId, pool, tokenA, tokenB, txPoolAccounts } = poolSimulationParams;
    const poolData = (pool as AutoUpdateAccountWithData<WhirlpoolData>).get();

    const tickArrayIndexFunc = OrcaDexSimulation.getTickArrayIndicesFunc(poolData, aToB);

    const tickArrayStartIndexList = aToB
      ? [tickArrayIndexFunc(0), tickArrayIndexFunc(-1), tickArrayIndexFunc(-2)]
      : [tickArrayIndexFunc(0), tickArrayIndexFunc(1), tickArrayIndexFunc(2)];

    const [tickArray0, tickArray1, tickArray2] = tickArrayStartIndexList.map((startIndex: number) =>
      OrcaDexSimulation.getTickArrayPDA(programId, pool.address, startIndex),
    );

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
        tickArray0,
        tickArray1,
        tickArray2,
        oracle: txPoolAccounts["oracle"],
        swapState: ArbSwapStatePDA.getInstance(),
        orcaSwapProgram: poolSimulationParams.programId,
      })
      .instruction();
  }
}
