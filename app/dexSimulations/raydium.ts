import {
  ClmmConfigInfo,
  ClmmPoolInfo,
  MAX_SQRT_PRICE_X64,
  MIN_SQRT_PRICE_X64,
  PoolUtils,
  TICK_ARRAY_SIZE,
  Tick,
  TickArray,
  TickArrayBitmapExtensionLayout,
  TickArrayState,
  TickState,
  getPdaExBitmapAccount,
  getPdaTickArrayAddress,
} from "@raydium-io/raydium-sdk";
import RaydiumAmmV3 from "../../idl/raydiumAmmV3.json";
import {
  AutoUpdateAccountWithData,
  DexSimulation,
  PoolSimulationParams,
  parsedDexConfig,
} from "./base";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PathLike, readFileSync } from "fs";
import { WalletWithTokenMap, getProgram, tickArrayKeyByIndex } from "../utils";
import { BN, Idl } from "@coral-xyz/anchor";
import { ArbProgram, ArbSwapStatePDA, TokenInfoMap } from "../singletons";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { TickArrayPDASet } from "../types";
import { ConnectionPool } from "../connectionPool";

interface RaydiumAmmV3Config {
  poolState: string;
  tokenA: string;
  tokenB: string;
  ammConfig: string;
  tokenAVault: string;
  tokenBVault: string;
  observationState: string;
}

interface RaydiumDexConfig {
  programAddress: string;
  pools: RaydiumAmmV3Config[];
}

export class RaydiumDexSimulation extends DexSimulation {
  readonly name: string = "raydium";

  static getTickArrayIndicesFunc(poolInfo: ClmmPoolInfo) {
    const { tickSpacing, tickCurrent } = poolInfo;
    const multiplier = tickSpacing * TICK_ARRAY_SIZE;
    const curStartIndex = Math.floor(tickCurrent / multiplier) * multiplier;

    const fullTickArraySize = TICK_ARRAY_SIZE * tickSpacing;
    return (tickArrayOffset: number) => curStartIndex + tickArrayOffset * fullTickArraySize;
  }

  static getRaydiumAmmV3TickArrays(
    programId: PublicKey,
    poolInfoAccountWithData: AutoUpdateAccountWithData<ClmmPoolInfo>,
    aToB: boolean,
  ): TickArrayPDASet {
    const tickArrayStartIndexFunc = this.getTickArrayIndicesFunc(poolInfoAccountWithData.get());
    // const [prevTickArrayIndex, curTickArrayIndex, nextTickArrayIndex, skipNextTickArrayIndex] =
    //   RaydiumDexSimulation.getTickArrayIndices(poolInfoAccountWithData.get(), aToB);
    return {
      curTickArray: getPdaTickArrayAddress(
        programId,
        poolInfoAccountWithData.address,
        tickArrayStartIndexFunc(0),
      )?.publicKey,
      skipPrevTickArrayIndex: getPdaTickArrayAddress(
        programId,
        poolInfoAccountWithData.address,
        tickArrayStartIndexFunc(-2),
      )?.publicKey,
      prevTickArrayIndex: getPdaTickArrayAddress(
        programId,
        poolInfoAccountWithData.address,
        tickArrayStartIndexFunc(-1),
      )?.publicKey,
      nextTickArrayIndex: getPdaTickArrayAddress(
        programId,
        poolInfoAccountWithData.address,
        tickArrayStartIndexFunc(1),
      )?.publicKey,
      skipNextTickArrayIndex: getPdaTickArrayAddress(
        programId,
        poolInfoAccountWithData.address,
        tickArrayStartIndexFunc(2),
      )?.publicKey,
    };
  }

  static tickArrayStateToTickArray(tickArrayState: TickArrayState): TickArray {
    const { startTickIndex, initializedTickCount } = tickArrayState;
    return {
      address: null, // need to add this in computation
      poolId: tickArrayState.ammPool,
      ticks: tickArrayState.ticks.map(
        (tickState: TickState): Tick => ({
          rewardGrowthsOutsideX64: tickState.rewardGrowthsOutside,
          ...tickState,
        }),
      ),
      startTickIndex,
      initializedTickCount,
    };
  }

  static parsedPoolStateToClmmPoolInfo(parsedPoolState: any, programId: PublicKey): ClmmPoolInfo {
    const tokenMintA = parsedPoolState?.tokenMint0 as PublicKey;
    const tokenMintB = parsedPoolState?.tokenMint1 as PublicKey;
    const tokenVaultA = parsedPoolState?.tokenVault0 as PublicKey;
    const tokenVaultB = parsedPoolState?.tokenVault1 as PublicKey;

    if (!tokenMintA || !tokenMintB || !tokenVaultA || !tokenVaultB) {
      throw Error(`invalid parsedPoolState ${parsedPoolState}`);
    }

    const castedPoolState = parsedPoolState as ClmmPoolInfo;
    const mintToTokenMap = TokenInfoMap.getMintMap();
    const mintA = {
      programId: TOKEN_PROGRAM_ID,
      vault: tokenMintA,
      ...mintToTokenMap[tokenMintA.toString()],
    };
    const mintB = {
      programId: TOKEN_PROGRAM_ID,
      vault: tokenMintB,
      ...mintToTokenMap[tokenMintB.toString()],
    };

    return {
      mintA,
      mintB,
      programId,
      // need to add id in computation
      ...castedPoolState,
    };
  }

  protected loadAndInitializeDexConfig(dexConfigPath: PathLike): parsedDexConfig {
    this.constantWatchingAccount = ["ammConfig"];

    const raydiumDexConfig: RaydiumDexConfig = JSON.parse(readFileSync(dexConfigPath).toString());
    let poolSimulationParamsList: PoolSimulationParams[] = [];
    const programPubkey = new PublicKey(raydiumDexConfig.programAddress);
    const raydiumProgram = getProgram(RaydiumAmmV3 as Idl, programPubkey);

    const poolInfoDecoder = (dataBuffer: Buffer) =>
      RaydiumDexSimulation.parsedPoolStateToClmmPoolInfo(
        raydiumProgram.account.poolState.coder.accounts.decode("PoolState", dataBuffer),
        programPubkey,
      );

    const getTickArrayDecoder = (poolId: PublicKey, address: PublicKey) => ((dataBuffer: Buffer) => {
      const rawResult = RaydiumDexSimulation.tickArrayStateToTickArray(
        raydiumProgram.account.tickArrayState.coder.accounts.decode("TickArrayState", dataBuffer),
      )

      return {
        ...rawResult,
        poolId,
        address,
      } as TickArray;
    })

    for (const poolConfig of raydiumDexConfig.pools) {
      const poolPubkey = new PublicKey(poolConfig.poolState);
      const { publicKey: bitMapExtensionPubkey } = getPdaExBitmapAccount(programPubkey, poolPubkey);
      const poolSimulation: PoolSimulationParams = {
        programId: programPubkey,
        pool: new AutoUpdateAccountWithData<ClmmPoolInfo>(
          new PublicKey(poolConfig.poolState),
          this.connectionPool,
          poolInfoDecoder,
        ),
        tokenA: poolConfig.tokenA,
        tokenB: poolConfig.tokenB,
        watchedPoolAccounts: {
          ammConfig: new AutoUpdateAccountWithData<ClmmConfigInfo>(
            new PublicKey(poolConfig.ammConfig),
            this.connectionPool,
            (dataBuffer: Buffer) =>
              raydiumProgram.account.ammConfig.coder.accounts.decode("AmmConfig", dataBuffer),
          ),
          tickArrayBitmapExtension: new AutoUpdateAccountWithData<TickArrayBitmapExtensionLayout>(
            bitMapExtensionPubkey,
            this.connectionPool,
            (dataBuffer: Buffer) =>
              raydiumProgram.account.tickArrayBitmapExtension.coder.accounts.decode(
                "TickArrayBitmapExtension",
                dataBuffer,
              ),
          ),
        },
        txPoolAccounts: {
          ammConfig: new PublicKey(poolConfig.ammConfig),
          tokenAVault: new PublicKey(poolConfig.tokenAVault),
          tokenBVault: new PublicKey(poolConfig.tokenBVault),
          observationState: new PublicKey(poolConfig.observationState),
        },
      };

      const connectionPool = this.connectionPool;
      poolSimulation.pool.registerOnUpdate(async () => {
        const tickArrayIndexFunc = RaydiumDexSimulation.getTickArrayIndicesFunc(
          (poolSimulation.pool as AutoUpdateAccountWithData<ClmmPoolInfo>).get(),
        );

        const promiseList = [];
        for (const index of [
          tickArrayIndexFunc(-2),
          tickArrayIndexFunc(-1),
          tickArrayIndexFunc(0),
          tickArrayIndexFunc(1),
          tickArrayIndexFunc(2),
        ]) {
          const tickArrayKey = tickArrayKeyByIndex(index);
          if (!poolSimulation.watchedPoolAccounts[tickArrayKey]) {
            const tickArrayAddress = getPdaTickArrayAddress(
              programPubkey,
              poolSimulation.pool.address,
              index,
            )?.publicKey;

            poolSimulation.watchedPoolAccounts[tickArrayKey] =
              new AutoUpdateAccountWithData<TickArray>(
                tickArrayAddress,
                connectionPool,
                getTickArrayDecoder(poolSimulation.pool.address, tickArrayAddress),
              );
            promiseList.push(poolSimulation.watchedPoolAccounts[tickArrayKey].start());
          }
        }

        for (const index of [tickArrayIndexFunc(-3), tickArrayIndexFunc(3)]) {
          const tickArrayKey = tickArrayKeyByIndex(index);
          if (!!poolSimulation.watchedPoolAccounts[tickArrayKey]) {
            promiseList.push(poolSimulation.watchedPoolAccounts[tickArrayKey].stop());
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

  public async preCalculationUpdate(connectionPool: ConnectionPool, poolSimulationParams: PoolSimulationParams, aToB: boolean): Promise<PoolSimulationParams> {
    const { programId, watchedPoolAccounts, pool } = poolSimulationParams;
    const tickArrayIndexFunc = RaydiumDexSimulation.getTickArrayIndicesFunc((poolSimulationParams.pool as AutoUpdateAccountWithData<ClmmPoolInfo>).get());
    const tickArrayStartIndexList = aToB
      ? [tickArrayIndexFunc(0), tickArrayIndexFunc(-1), tickArrayIndexFunc(-2)]
      : [tickArrayIndexFunc(0), tickArrayIndexFunc(1), tickArrayIndexFunc(2)];
    
    const raydiumProgram = getProgram(RaydiumAmmV3 as Idl, programId);
    const getTickArrayDecoder = (poolId: PublicKey, address: PublicKey) => ((dataBuffer: Buffer) => {
      const rawResult = RaydiumDexSimulation.tickArrayStateToTickArray(
        raydiumProgram.account.tickArrayState.coder.accounts.decode("TickArrayState", dataBuffer),
      )

      return {
        ...rawResult,
        poolId,
        address,
      } as TickArray;
    });

    await Promise.all(
      tickArrayStartIndexList.map(async (startIndex: number) => {
        const tickArrayKey = tickArrayKeyByIndex(startIndex);
        const { publicKey: tickArrayAddress }= getPdaTickArrayAddress(
          programId,
          pool.address,
          startIndex,
        );
        
        if (!watchedPoolAccounts[tickArrayKey]) {
          watchedPoolAccounts[tickArrayKey] = new AutoUpdateAccountWithData<TickArray>(
            tickArrayAddress,
            connectionPool,
            getTickArrayDecoder(pool.address, tickArrayAddress),
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
    inAmount: BN,
    aToB: boolean,
  ): BN {
    const { pool, tokenA, tokenB, watchedPoolAccounts } = poolSimulationParams;
    const inputToken = aToB
      ? TokenInfoMap.getSymbolMap()[tokenA]
      : TokenInfoMap.getSymbolMap()[tokenB];
    const poolInfo = (pool as AutoUpdateAccountWithData<ClmmPoolInfo>).get();

    const tickArrayIndexFunc = RaydiumDexSimulation.getTickArrayIndicesFunc(poolInfo);
    const currentIndex = tickArrayIndexFunc(0);
    const nextIndex = aToB ? tickArrayIndexFunc(-1) : tickArrayIndexFunc(1);
    const skipNextIndex = aToB ? tickArrayIndexFunc(-2) : tickArrayIndexFunc(2);

    const curTickArrayAutoUpdateAccount = watchedPoolAccounts[
      tickArrayKeyByIndex(currentIndex)
    ] as AutoUpdateAccountWithData<TickArray>;

    const nextTickArrayAutoUpdateAccount = watchedPoolAccounts[
      tickArrayKeyByIndex(nextIndex)
    ] as AutoUpdateAccountWithData<TickArray>;

    const skipNextTickArrayAutoUpdateAccount = watchedPoolAccounts[
      tickArrayKeyByIndex(skipNextIndex)
    ] as AutoUpdateAccountWithData<TickArray>;

    const tickArrayCache = {};
    tickArrayCache[currentIndex] = curTickArrayAutoUpdateAccount?.get();
    tickArrayCache[nextIndex] = nextTickArrayAutoUpdateAccount?.get();
    tickArrayCache[skipNextIndex] = skipNextTickArrayAutoUpdateAccount?.get();
 
    const ammConfig: ClmmConfigInfo = (
      watchedPoolAccounts["ammConfig"] as AutoUpdateAccountWithData<ClmmConfigInfo>
    ).get();
    poolInfo.id = poolSimulationParams.pool.address;
    poolInfo.ammConfig = ammConfig;

    /**
     * may need to fetch actual bitmap in the future
     */
    poolInfo.exBitmapInfo = {
      poolId: pool.address,
      positiveTickArrayBitmap: Array(14).fill(Array(8).fill(new BN(0))),
      negativeTickArrayBitmap: Array(14).fill(Array(8).fill(new BN(0))),
    };

    const { expectedAmountOut } = PoolUtils.getOutputAmountAndRemainAccounts(
      poolInfo,
      tickArrayCache,
      inputToken.mint,
      inAmount,
      aToB ? new BN(MIN_SQRT_PRICE_X64) : new BN(MAX_SQRT_PRICE_X64),
    );
    return expectedAmountOut;
  }

  protected poolSimuluationGetAmountOut(
    poolSimulationParams: PoolSimulationParams,
    inAmount: BN,
    aToB: boolean,
  ): BN {
    return DexSimulation.outZeroOnFailure(
      poolSimulationParams,
      inAmount,
      aToB,
      RaydiumDexSimulation.poolSimuluationGetAmountOutInternal,
    );
  }

  protected poolSimulationArbInstruction(
    poolSimulationParams: PoolSimulationParams,
    aToB: boolean,
    payer: WalletWithTokenMap,
  ): Promise<TransactionInstruction> {
    const arbProgram = ArbProgram.getInstance();
    const { pool, tokenA, tokenB, watchedPoolAccounts, txPoolAccounts } = poolSimulationParams;
    const [userSrc, userDst] = aToB
      ? [payer.getTokenAccountPubkey(tokenA), payer.getTokenAccountPubkey(tokenB)]
      : [payer.getTokenAccountPubkey(tokenB), payer.getTokenAccountPubkey(tokenA)];
    const [inputVault, outputVault] = aToB
      ? [txPoolAccounts["tokenAVault"], txPoolAccounts["tokenBVault"]]
      : [txPoolAccounts["tokenBVault"], txPoolAccounts["tokenAVault"]];

    const tickArrayIndexFunc = RaydiumDexSimulation.getTickArrayIndicesFunc((poolSimulationParams.pool as AutoUpdateAccountWithData<ClmmPoolInfo>).get());
    const curTickArrayIndex = tickArrayIndexFunc(0);
    const nextTickArrayIndex = aToB ? tickArrayIndexFunc(-1) : tickArrayIndexFunc(1);
    const skipNextTickArrayIndex = aToB ? tickArrayIndexFunc(-2) : tickArrayIndexFunc(2);

    const tickArrayKey = tickArrayKeyByIndex(curTickArrayIndex);
    const nextTickArrayKey = tickArrayKeyByIndex(nextTickArrayIndex);
    const skipNextTickArrayKey = tickArrayKeyByIndex(skipNextTickArrayIndex);

    const remainingAccounts = [];
    if (watchedPoolAccounts[nextTickArrayKey].address) {
      remainingAccounts.push({
        pubkey: watchedPoolAccounts[nextTickArrayKey].address,
        isWritable: true,
        isSigner: false,
      });
    }
    if (watchedPoolAccounts[skipNextTickArrayKey].address) {
      remainingAccounts.push({
        pubkey: watchedPoolAccounts[skipNextTickArrayKey].address,
        isWritable: true,
        isSigner: false,
      });
    }

    return arbProgram.methods
      .raydiumSwap(aToB)
      .accounts({
        payer: payer.publicKey,
        ammConfig: txPoolAccounts["ammConfig"],
        poolState: pool.address,
        userSrc,
        userDst,
        inputVault,
        outputVault,
        observationState: txPoolAccounts["observationState"],
        tickArray: watchedPoolAccounts[tickArrayKey].address,
        tokenProgram: TOKEN_PROGRAM_ID,
        raydiumSwapProgram: poolSimulationParams.programId,
        swapState: ArbSwapStatePDA.getInstance(),
      })
      .remainingAccounts(remainingAccounts)
      .instruction();
  }
}
