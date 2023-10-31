import { EventEmitter } from "events";
import { Token } from "./types";
import fs from "fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Idl, Program, Provider, Wallet } from "@coral-xyz/anchor";
import {
  ARB_PROGRAM_KEY_PAIR_PATH,
  SOLANA_DEFAULT_ENDPOINT,
  WALLET_KEY_PAIR_PATH,
} from "./constant";
import { loadKeypairFromPath } from "./utils";
import TmpIdl from "../idl/tmp.json";

export class UpdateEventEmitter extends EventEmitter {
  private static instance: UpdateEventEmitter;
  private constructor() {
    super();
  }

  public static getInstance() {
    if (!UpdateEventEmitter.instance) {
      UpdateEventEmitter.instance = new UpdateEventEmitter();
      UpdateEventEmitter.instance.setMaxListeners(1000000);
    }
    return UpdateEventEmitter.instance;
  }
}

export class ArbProgramKeyPair extends Keypair {
  private static instance: ArbProgramKeyPair;
  private constructor() {
    super();
  }

  public static getInstance() {
    if (!this.instance) {
      this.instance = loadKeypairFromPath(ARB_PROGRAM_KEY_PAIR_PATH);
    }
    return this.instance;
  }
}

export class ArbSwapStatePDA extends PublicKey {
  private static instance: ArbSwapStatePDA;
  private constructor(pubkey: PublicKey) {
    super(pubkey);
  }

  public static getInstance() {
    if (!this.instance) {
      const [pubkey] = PublicKey.findProgramAddressSync(
        [Buffer.from("swap_state")],
        ArbProgramKeyPair.getInstance().publicKey,
      );
      this.instance = new ArbSwapStatePDA(pubkey);
    }
    return this.instance;
  }
}

export class ArbProgram extends Program<Idl> {
  private static instance: ArbProgram;
  private constructor(
    idl: Idl,
    programId: PublicKey,
    provider: Provider,
    swapStatePubkey: PublicKey,
  ) {
    super(idl, programId, provider);
    this.swapStatePubkey = swapStatePubkey;
  }

  readonly swapStatePubkey: PublicKey;

  public static getInstance() {
    if (!this.instance) {
      const connection = new Connection(SOLANA_DEFAULT_ENDPOINT);
      const wallet = ArbWallet.getInstance();

      const provider = new AnchorProvider(connection, wallet, {
        skipPreflight: false,
        commitment: "finalized",
      });

      this.instance = new ArbProgram(
        TmpIdl as Idl,
        ArbProgramKeyPair.getInstance().publicKey,
        provider,
        ArbSwapStatePDA.getInstance(),
      );
    }
    return this.instance;
  }
}

export class ArbWallet extends Wallet {
  private static instance: ArbWallet;
  private constructor(keypair: Keypair) {
    super(keypair);
  }

  public static getInstance() {
    if (!this.instance) {
      this.instance = new ArbWallet(loadKeypairFromPath(WALLET_KEY_PAIR_PATH));
    }
    return this.instance;
  }
}

export class TokenInfoMap {
  readonly symbolMap: Record<string, Token>;
  readonly mintMap: Record<string, Token>;
  private static instance: TokenInfoMap;
  private constructor() {
    const tokenInfoConfigs: Record<string, any>[] = JSON.parse(
      fs.readFileSync(
        "/Users/leqiang/Documents/crypto/trade/solana_arb_rs/contract/app/configs/tokens.json",
        "utf-8",
      ),
    );
    this.symbolMap = {};
    this.mintMap = {};
    for (const tokenInfoConfig of tokenInfoConfigs) {
      const symbol = tokenInfoConfig["symbol"];
      const decimals = parseInt(tokenInfoConfig["decimals"]);
      const mint = tokenInfoConfig["mint"];
      const token: Token = {
        symbol,
        decimals,
        mint: new PublicKey(mint),
      };

      this.symbolMap[symbol] = token;
      this.mintMap[mint] = token;
    }
  }

  public static getSymbolMap() {
    if (!TokenInfoMap.instance) {
      TokenInfoMap.instance = new TokenInfoMap();
    }
    return TokenInfoMap.instance.symbolMap;
  }

  public static getMintMap() {
    if (!TokenInfoMap.instance) {
      TokenInfoMap.instance = new TokenInfoMap();
    }
    return TokenInfoMap.instance.mintMap;
  }
}
