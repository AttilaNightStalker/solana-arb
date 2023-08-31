import * as anchor from "@coral-xyz/anchor";
import {
  AccountInfo,
  Connection,
  Context,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { PathLike, promises } from "fs";
import { UpdateEventEmitter } from "../singletons";
import { WalletWithTokenMap } from "../utils";

/**
 * auto update account (abstract)
 */
abstract class AutoUpdateAccount {
  readonly address: PublicKey;
  protected connection: Connection;
  protected subscribeId: number;
  protected onUpdateCallbacks: (() => any)[];

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  public registerOnUpdate(onUpdate: () => any) {
    this.onUpdateCallbacks.push(onUpdate);
  }

  constructor(address: string | PublicKey, connection: Connection) {
    this.address = new PublicKey(address);
    this.connection = connection;
    this.subscribeId = -1;
    this.onUpdateCallbacks = [];
  }
}

/**
 * auto update account with data
 */
export class AutoUpdateAccountWithData<T> extends AutoUpdateAccount {
  accountData: T;
  private decoder: (data: Buffer) => T;

  async start(): Promise<void> {
    if (this.subscribeId !== -1) {
      return;
    }

    this.accountData = this.decoder((await this.connection.getAccountInfo(this.address))?.data);
    await Promise.all(this.onUpdateCallbacks.map((callback) => callback()));

    this.subscribeId = this.connection.onAccountChange(
      this.address,
      (accountInfo: AccountInfo<Buffer>, _context: Context) => {
        this.accountData = this.decoder(accountInfo.data);
        this.onUpdateCallbacks.map((callback) => callback());
      },
    );
  }

  async stop(): Promise<void> {
    if (this.subscribeId === -1) {
      return;
    }
    await this.connection.removeAccountChangeListener(this.subscribeId);
    this.subscribeId = -1;
    return;
  }

  get(): T {
    return this.accountData;
  }

  constructor(address: string | PublicKey, connection: Connection, decoder: (data: Buffer) => T) {
    super(address, connection);
    this.decoder = decoder;
  }
}

export type PoolSimulationParams = {
  programId: PublicKey;
  pool: AutoUpdateAccount;
  tokenA: string;
  tokenB: string;
  watchedPoolAccounts: Record<string, AutoUpdateAccount>;
  txPoolAccounts: Record<string, PublicKey>;
};

export class PoolSimulation {
  readonly poolSimulationParams: PoolSimulationParams;
  private constantWatchingKeys: string[];

  private batchOpOnAccounts<T>(op: (autoUpdateAccount: AutoUpdateAccount) => T): T[] {
    return Object.entries(this.poolSimulationParams.watchedPoolAccounts)
      .map(([_key, value]) => op(value))
      .concat(op(this.poolSimulationParams.pool));
  }

  private constructArbInstruction: (
    PoolSimulationParams: PoolSimulationParams,
    aToB: boolean,
    payer: WalletWithTokenMap,
  ) => Promise<TransactionInstruction>;
  private computeSwapAmountOut: (
    poolSimulationParams: PoolSimulationParams,
    inAmount: anchor.BN,
    aToB: boolean,
  ) => anchor.BN;

  public getEventName() {
    return this.poolSimulationParams.pool.address.toString();
  }
  public accountsUpdateEvent() {
    return this.poolSimulationParams.pool.address.toString();
  }

  public getAmountOut(inAmount: anchor.BN, aToB: boolean) {
    return this.computeSwapAmountOut(this.poolSimulationParams, inAmount, aToB);
  }

  public getSwapInstruction(aToB: boolean, payer: WalletWithTokenMap) {
    return this.constructArbInstruction(this.poolSimulationParams, aToB, payer);
  }

  public registerEventUpdateCallback(callback: () => any) {
    UpdateEventEmitter.getInstance().on(this.getEventName(), callback);
  }

  async start(): Promise<void> {
    const { watchedPoolAccounts, pool } = this.poolSimulationParams;
    await Promise.all(
      this.constantWatchingKeys
        .map((key: string) => watchedPoolAccounts[key]?.start())
        .concat(pool.start()),
    );
  }

  constructor(
    poolSimulationParams: PoolSimulationParams,
    constructArbInstruction: (
      PoolSimulationParams: PoolSimulationParams,
      aToB: boolean,
      payer: WalletWithTokenMap,
    ) => Promise<TransactionInstruction>,
    computeSwapAmountOut: (
      poolSimulationParams: PoolSimulationParams,
      inAmount: anchor.BN,
      aToB: boolean,
    ) => anchor.BN,
    constantWatchingKeys: string[],
  ) {
    this.poolSimulationParams = poolSimulationParams;
    this.computeSwapAmountOut = computeSwapAmountOut;
    this.constructArbInstruction = constructArbInstruction;

    this.batchOpOnAccounts((autoUpdateAccount: AutoUpdateAccount) =>
      autoUpdateAccount.registerOnUpdate(() =>
        UpdateEventEmitter.getInstance().emit(
          this.getEventName(),
          autoUpdateAccount.address.toString(),
        ),
      ),
    );
    this.constantWatchingKeys = constantWatchingKeys;
  }
}

/**
 * Arb path node
 */
export type ArbPathNode = {
  fromToken: string;
  toToken: string;
  getAmountOut: (amountIn: anchor.BN) => anchor.BN;
  getArbInstruction: () => Promise<TransactionInstruction>;
  activate: () => Promise<void>;
  registerUpdateCallback: (callback: () => any) => void;
};

export type parsedDexConfig = {
  programId: PublicKey;
  poolSimulationParamsList: PoolSimulationParams[];
};

export abstract class DexSimulation {
  protected connection: Connection;
  protected programId: PublicKey;
  protected poolSimulations: PoolSimulation[];
  protected tokenPairs: Record<string, string[]>;
  protected tokenPairToPoolSimulations: Record<string, PoolSimulation[]>;

  protected constantWatchingAccount: string[];

  protected abstract loadAndInitializeDexConfig(dexConfigPath: PathLike): parsedDexConfig;
  protected abstract poolSimuluationGetAmountOut(
    poolSimulationParams: PoolSimulationParams,
    inAmount: anchor.BN,
    aToB: boolean,
  ): anchor.BN;
  protected abstract poolSimulationArbInstruction(
    poolSimulationParams: PoolSimulationParams,
    aToB: boolean,
    payer: WalletWithTokenMap,
  ): Promise<TransactionInstruction>;

  public async getArbPaths(
    fromToken: string,
    toToken: string,
    payer: WalletWithTokenMap,
  ): Promise<ArbPathNode[]> {
    if (!payer.getTokenAccountPubkey(fromToken) || !payer.getTokenAccountPubkey(toToken)) {
      console.warn(`${fromToken}-${toToken} is not available for wallet ${payer.publicKey}`);
      return [];
    }

    let result: ArbPathNode[] = [];
    const poolSimulationsAtoB = this.tokenPairToPoolSimulations[`${fromToken}-${toToken}`] || [];
    for (const poolSimulation of poolSimulationsAtoB) {
      result.push({
        fromToken,
        toToken,
        getAmountOut: (amountIn: anchor.BN) => poolSimulation.getAmountOut(amountIn, true),
        getArbInstruction: () => poolSimulation.getSwapInstruction(true, payer),
        activate: () => poolSimulation.start(),
        registerUpdateCallback: (callback: () => any) =>
          poolSimulation.registerEventUpdateCallback(callback),
      });
    }

    const poolSimulationsBtoA = this.tokenPairToPoolSimulations[`${toToken}-${fromToken}`] || [];
    for (const poolSimulation of poolSimulationsBtoA) {
      result.push({
        fromToken,
        toToken,
        getAmountOut: (amountIn: anchor.BN) => poolSimulation.getAmountOut(amountIn, false),
        getArbInstruction: () => poolSimulation.getSwapInstruction(false, payer),
        activate: () => poolSimulation.start(),
        registerUpdateCallback: (callback: () => any) =>
          poolSimulation.registerEventUpdateCallback(callback),
      });
    }

    return result;
  }

  constructor(connection: Connection, poolConfigPath: PathLike) {
    this.connection = connection;
    this.tokenPairs = {};
    this.tokenPairToPoolSimulations = {};

    const parsedDexConfig = this.loadAndInitializeDexConfig(poolConfigPath);
    this.programId = parsedDexConfig.programId;

    for (const poolSimulationParams of parsedDexConfig.poolSimulationParamsList) {
      const poolSimulation = new PoolSimulation(
        poolSimulationParams,
        this.poolSimulationArbInstruction,
        this.poolSimuluationGetAmountOut,
        this.constantWatchingAccount,
      );
      const { tokenA, tokenB } = poolSimulationParams;
      if (!this.tokenPairs[tokenA]) {
        this.tokenPairs[tokenA] = [];
      }
      this.tokenPairs[tokenA].push(tokenB);
      if (!this.tokenPairs[tokenB]) {
        this.tokenPairs[tokenB] = [];
      }
      this.tokenPairs[tokenB].push(tokenA);

      const aToBPairString = `${tokenA}-${tokenB}`;
      if (!this.tokenPairToPoolSimulations[aToBPairString]) {
        this.tokenPairToPoolSimulations[aToBPairString] = [];
      }
      this.tokenPairToPoolSimulations[aToBPairString].push(poolSimulation);
    }
  }
}
