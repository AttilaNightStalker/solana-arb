import { PathLike, readFileSync } from "fs";
import {
  AutoUpdateAccountWithData,
  DexSimulation,
  PoolSimulationParams,
  parsedDexConfig,
} from "./base";
import { PublicKey } from "@saberhq/solana-contrib";
import {
  IExchangeInfo,
  StableSwapState,
  calculateAmpFactor,
  calculateEstimatedSwapOutputAmount,
  decodeSwap,
} from "@saberhq/stableswap-sdk";
import { BN } from "@coral-xyz/anchor";
import { TransactionInstruction } from "@solana/web3.js";
import { WalletWithTokenMap } from "../utils";

import {
  deserializeAccount,
  TokenAccountData,
  Token as TokenForSaber,
  TokenAmount,
} from "@saberhq/token-utils";
import { ArbProgram, ArbSwapStatePDA, TokenInfoMap } from "../singletons";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

interface SaberStableswapConfig {
  tokenA: string;
  tokenB: string;
  swapAccount: string;
  authority: string;
  poolTokenA: string;
  poolTokenB: string;
  adminTokenA: string;
  adminTokenB: string;
  lpMint: string;
  lpDecimals: number;
}

interface SaberDexConfig {
  programAddress: string;
  pools: SaberStableswapConfig[];
}

export class SaberDexSimulation extends DexSimulation {
  static makeExchangeInfo(
    tokenAData: TokenAccountData,
    tokenBData: TokenAccountData,
    tokenADecimals: number,
    tokenBDecimals: number,
    swapState: StableSwapState,
  ): IExchangeInfo {
    const ampFactor = calculateAmpFactor(swapState);
    return {
      ampFactor,
      fees: swapState.fees,
      lpTotalSupply: undefined,
      reserves: [
        {
          reserveAccount: swapState.tokenA.reserve,
          adminFeeAccount: swapState.tokenA.adminFeeAccount,
          amount: new TokenAmount(
            TokenForSaber.fromMint(tokenAData.mint, tokenADecimals),
            tokenAData.amount,
          ),
        },
        {
          reserveAccount: swapState.tokenB.reserve,
          adminFeeAccount: swapState.tokenB.adminFeeAccount,
          amount: new TokenAmount(
            TokenForSaber.fromMint(tokenBData.mint, tokenBDecimals),
            tokenBData.amount,
          ),
        },
      ],
    }
  }

  protected loadAndInitializeDexConfig(dexConfigPath: PathLike): parsedDexConfig {
    this.constantWatchingAccount = ["reserveA", "reserveB"];

    const saberDexConfig: SaberDexConfig = JSON.parse(readFileSync(dexConfigPath).toString());
    let poolSimulationParamsList: PoolSimulationParams[] = [];
    const programPubkey = new PublicKey(saberDexConfig.programAddress);

    for (const poolConfig of saberDexConfig.pools) {
      const poolSimulation: PoolSimulationParams = {
        programId: programPubkey,
        pool: new AutoUpdateAccountWithData<StableSwapState>(
          new PublicKey(poolConfig.swapAccount),
          this.connection,
          decodeSwap,
        ),
        tokenA: poolConfig.tokenA,
        tokenB: poolConfig.tokenB,
        watchedPoolAccounts: {
          reserveA: new AutoUpdateAccountWithData<TokenAccountData>(
            new PublicKey(poolConfig.poolTokenA),
            this.connection,
            deserializeAccount,
          ),
          reserveB: new AutoUpdateAccountWithData<TokenAccountData>(
            new PublicKey(poolConfig.poolTokenB),
            this.connection,
            deserializeAccount,
          ),
        },
        txPoolAccounts: {
          authority: new PublicKey(poolConfig.authority),
          adminTokenA: new PublicKey(poolConfig.adminTokenA),
          adminTokenB: new PublicKey(poolConfig.adminTokenB),
          lpMint: new PublicKey(poolConfig.lpMint),
        },
        miscData: {
          lpDecimals: poolConfig.lpDecimals,
        },
      };

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
    const tokenSymbolMap = TokenInfoMap.getSymbolMap();
    const tokenA = tokenSymbolMap[poolSimulationParams.tokenA];
    const tokenB = tokenSymbolMap[poolSimulationParams.tokenB];
    const { watchedPoolAccounts, pool, miscData } = poolSimulationParams;
    const tokenAData = (
      watchedPoolAccounts.reserveA as AutoUpdateAccountWithData<TokenAccountData>
    ).get();
    const tokenBData = (
      watchedPoolAccounts.reserveB as AutoUpdateAccountWithData<TokenAccountData>
    ).get();
    const swapState = (pool as AutoUpdateAccountWithData<StableSwapState>).get();

    const exchangeInfo = SaberDexSimulation.makeExchangeInfo(
      tokenAData,
      tokenBData,
      tokenA.decimals,
      tokenB.decimals,
      swapState,
    );
    const fromAmount = aToB
      ? new TokenAmount(TokenForSaber.fromMint(tokenA.mint, tokenA.decimals), inAmount)
      : new TokenAmount(TokenForSaber.fromMint(tokenB.mint, tokenB.decimals), inAmount);

    const { outputAmount } = calculateEstimatedSwapOutputAmount(exchangeInfo, fromAmount);
    return new BN(outputAmount.toU64());
  }

  protected poolSimulationArbInstruction(
    poolSimulationParams: PoolSimulationParams,
    aToB: boolean,
    payer: WalletWithTokenMap,
  ): Promise<TransactionInstruction> {
    const arbProgram = ArbProgram.getInstance();
    const { pool, txPoolAccounts, watchedPoolAccounts, tokenA, tokenB, programId } = poolSimulationParams;
    const [userSrc, userDst] = aToB
      ? [payer.getTokenAccountPubkey(tokenA), payer.getTokenAccountPubkey(tokenB)]
      : [payer.getTokenAccountPubkey(tokenB), payer.getTokenAccountPubkey(tokenA)];
    const [poolSrc, poolDst] = aToB
      ? [watchedPoolAccounts.poolTokenA.address, watchedPoolAccounts.poolTokenB.address]
      : [watchedPoolAccounts.poolTokenB.address, watchedPoolAccounts.poolTokenA.address];

    const feeDst = aToB ? txPoolAccounts.adminFeeAccountB : txPoolAccounts.adminFeeAccountA;

    return arbProgram.methods.saberSwap().accounts(
      {
        poolAccount: pool.address,
        authority: txPoolAccounts.authority,
        userTransferAuthority: payer.publicKey,
        userSrc,
        userDst,
        poolSrc,
        poolDst,
        feeDst,
        programId,
        swapState: ArbSwapStatePDA.getInstance(),
        tokenProgram: TOKEN_PROGRAM_ID,
      }
    ).instruction()
  }
}
