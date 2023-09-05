import {
  ClmmConfigInfo,
  ClmmPoolInfo,
  MAX_SQRT_PRICE_X64,
  MIN_SQRT_PRICE_X64,
  PoolUtils,
  TICK_ARRAY_SIZE,
  Tick,
  TickArray,
  TickArrayState,
  TickState,
  getPdaTickArrayAddress,
} from "@raydium-io/raydium-sdk";
import RaydiumAmmV3 from "../idl/raydiumAmmV3.json";
import {
  AutoUpdateAccountWithData,
  DexSimulation,
  PoolSimulationParams,
  parsedDexConfig,
} from "./base";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PathLike, readFileSync } from "fs";
import { WalletWithTokenMap, getProgram, tickArrayKeyByIndex } from "../utils";
import { BN, Idl } from "@coral-xyz/anchor";
import { ArbProgram, ArbSwapStatePDA, TokenInfoMap } from "../singletons";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { TickArrayPDASet } from "../types";

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

    const tickArrayDecoder = (dataBuffer: Buffer) =>
      RaydiumDexSimulation.tickArrayStateToTickArray(
        raydiumProgram.account.tickArrayState.coder.accounts.decode("TickArrayState", dataBuffer),
      );

    for (const poolConfig of raydiumDexConfig.pools) {
      const poolSimulation: PoolSimulationParams = {
        programId: programPubkey,
        pool: new AutoUpdateAccountWithData<ClmmPoolInfo>(
          new PublicKey(poolConfig.poolState),
          this.connection,
          poolInfoDecoder,
        ),
        tokenA: poolConfig.tokenA,
        tokenB: poolConfig.tokenB,
        watchedPoolAccounts: {
          ammConfig: new AutoUpdateAccountWithData<ClmmConfigInfo>(
            new PublicKey(poolConfig.ammConfig),
            this.connection,
            (dataBuffer: Buffer) =>
              raydiumProgram.account.ammConfig.coder.accounts.decode("AmmConfig", dataBuffer),
          ),
        },
        txPoolAccounts: {
          ammConfig: new PublicKey(poolConfig.ammConfig),
          tokenAVault: new PublicKey(poolConfig.tokenAVault),
          tokenBVault: new PublicKey(poolConfig.tokenBVault),
          observationState: new PublicKey(poolConfig.observationState),
        },
      };

      const connection = this.connection;
      poolSimulation.pool.registerOnUpdate(async () => {
        const tickArrayIndexFunc = RaydiumDexSimulation.getTickArrayIndicesFunc(
          (poolSimulation.pool as AutoUpdateAccountWithData<ClmmPoolInfo>).get(),
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
              new AutoUpdateAccountWithData<TickArray>(
                getPdaTickArrayAddress(
                  programPubkey,
                  poolSimulation.pool.address,
                  index,
                )?.publicKey,
                connection,
                tickArrayDecoder,
              );
            promiseList.push(poolSimulation.watchedPoolAccounts[tickArrayKey].start());
          }
        }

        for (const index of [tickArrayIndexFunc(-2), tickArrayIndexFunc(2)]) {
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

  protected poolSimuluationGetAmountOut(
    poolSimulationParams: PoolSimulationParams,
    inAmount: BN,
    aToB: boolean,
  ): BN {
    const { pool, tokenA, tokenB, watchedPoolAccounts, programId } = poolSimulationParams;
    const inputToken = aToB
      ? TokenInfoMap.getSymbolMap()[tokenA]
      : TokenInfoMap.getSymbolMap()[tokenB];
    const poolInfo = (pool as AutoUpdateAccountWithData<ClmmPoolInfo>).get();

    const tickArrayIndexFunc = RaydiumDexSimulation.getTickArrayIndicesFunc(poolInfo);
    const currentIndex = tickArrayIndexFunc(0);
    const nextIndex = aToB ? tickArrayIndexFunc(-1) : tickArrayIndexFunc(1);

    const curTickArrayAutoUpdateAccount = watchedPoolAccounts[
      tickArrayKeyByIndex(currentIndex)
    ] as AutoUpdateAccountWithData<TickArray>;

    const nextTickArrayAutoUpdateAccount = watchedPoolAccounts[
      tickArrayKeyByIndex(nextIndex)
    ] as AutoUpdateAccountWithData<TickArray>;

    const tickArrayCache = {};
    tickArrayCache[currentIndex] = curTickArrayAutoUpdateAccount.get();
    tickArrayCache[nextIndex] = nextTickArrayAutoUpdateAccount.get();

    const ammConfig: ClmmConfigInfo = (
      watchedPoolAccounts["ammConfig"] as AutoUpdateAccountWithData<ClmmConfigInfo>
    ).get();
    poolInfo.id = poolSimulationParams.pool.address;
    poolInfo.ammConfig = ammConfig;

    const { expectedAmountOut } = PoolUtils.getOutputAmountAndRemainAccounts(
      poolInfo,
      tickArrayCache,
      inputToken.mint,
      inAmount,
      aToB ? new BN(MIN_SQRT_PRICE_X64) : new BN(MAX_SQRT_PRICE_X64),
    );
    return expectedAmountOut;
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

    const tickArrayIndexFunc = RaydiumDexSimulation.getTickArrayIndicesFunc(
      (pool as AutoUpdateAccountWithData<ClmmPoolInfo>).get(),
    );
    const curTickArrayIndex = tickArrayIndexFunc(0);
    const nextTickArrayIndex = aToB ? tickArrayIndexFunc(-1) : tickArrayIndexFunc(1);

    const tickArrayKey = tickArrayKeyByIndex(curTickArrayIndex);
    const nextTickArrayKey = tickArrayKeyByIndex(nextTickArrayIndex);

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
      .remainingAccounts(
        watchedPoolAccounts[nextTickArrayKey].address
          ? [
              {
                pubkey: watchedPoolAccounts[nextTickArrayKey].address,
                isWritable: true,
                isSigner: false,
              },
            ]
          : [],
      )
      .instruction();
  }
}
