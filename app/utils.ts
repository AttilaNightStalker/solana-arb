import { Idl, Program, Wallet, AnchorProvider, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs, { PathLike } from "fs";
import { Token, WalletTokenAccount } from "./types";
import { ArbWallet, TokenInfoMap } from "./singletons";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as SPLToken from "@solana/spl-token";
import { SOLANA_DEFAULT_ENDPOINT } from "./constant";

export const loadKeypairFromPath = (keypairPath: PathLike): Keypair =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));

export const getProgram = (idl: Idl, programPubkey: PublicKey, connection: Connection = null) => {
  if (!connection) {
    connection = new Connection(SOLANA_DEFAULT_ENDPOINT);
  }
  const wallet = ArbWallet.getInstance();

  const provider = new AnchorProvider(connection, wallet, {
    skipPreflight: false,
    commitment: "finalized",
  });
  return new Program(idl, programPubkey, provider);
};

export class WalletWithTokenMap extends Wallet {
  readonly tokenAccountMap: Record<string, WalletTokenAccount>;
  private constructor(payer: Keypair, tokenAccountMap: Record<string, WalletTokenAccount>) {
    super(payer);
    this.tokenAccountMap = tokenAccountMap;
  }

  public getTokenAccountPubkey(symbol: string) {
    return this.tokenAccountMap[symbol]?.accountPubkey;
  }

  public static async create(connection: Connection, wallet: Wallet): Promise<WalletWithTokenMap> {
    const tokenAccountMap: Record<string, WalletTokenAccount> = {};
    const mintToTokenMap: Record<string, Token> = TokenInfoMap.getMintMap();

    const getTokenAccountResp = await connection.getTokenAccountsByOwner(wallet.publicKey, {
      programId: TOKEN_PROGRAM_ID,
    });

    for (const { account, pubkey: accountPubkey } of getTokenAccountResp.value) {
      const parsedTokenAccount = SPLToken.AccountLayout.decode(account.data);
      const tokenMintStr = (parsedTokenAccount?.mint as PublicKey)?.toString();
      const token = mintToTokenMap[tokenMintStr];
      if (!!token) {
        tokenAccountMap[token.symbol] = {
          token,
          accountPubkey,
          ownerPubkey: wallet.publicKey,
        };
      }
    }

    return new WalletWithTokenMap(wallet.payer, tokenAccountMap);
  }
}

export const tickArrayKeyByIndex = (index: number) => `tickArray${index}`;

export const findOptimalTrade: (
  minAmountIn: BN,
  computation: (amountIn: BN) => BN,
  granularity: BN,
) => { optimalAmountIn: BN; optimalProfit: BN } = (
  minAmountIn: BN,
  computation: (amountIn: BN) => BN,
  granularity: BN,
) => {
  let lowerInAmount = minAmountIn;
  let lowerProfit = computation(lowerInAmount).sub(lowerInAmount);
  if (lowerProfit.lt(new BN(0))) {
    return {
      optimalAmountIn: minAmountIn,
      optimalProfit: lowerProfit,
    };
  }

  console.log({ granularity: granularity.toString() });

  let upperInAmount = lowerInAmount.mul(new BN(2));
  let upperProfit = computation(upperInAmount).sub(upperInAmount);

  while (upperProfit.gt(lowerProfit)) {
    lowerInAmount = upperInAmount;
    lowerProfit = upperProfit;
    upperInAmount = upperInAmount.mul(new BN(2));
    upperProfit = computation(upperInAmount).sub(upperInAmount);
  }

  lowerProfit = lowerProfit.eq(minAmountIn) ? minAmountIn : lowerProfit.div(new BN(2));

  let gap = upperInAmount.sub(lowerInAmount);
  while (gap.gt(granularity)) {
    const segment = gap.div(new BN(3));
    const first = lowerInAmount.add(segment);
    const second = first.add(segment);
    const profitFirst = computation(first).sub(first);
    const profitSecond = computation(second).sub(second);

    console.log({
      segment: segment.toString(),
      first: first.toString(),
      second: second.toString(),
      profitFirst: profitFirst.toString(),
      profitSecond: profitSecond.toString(),
    });

    if (upperProfit.gt(profitSecond)) {
      lowerInAmount = second;
      lowerProfit = profitSecond;
    } else if (profitSecond.gt(profitFirst)) {
      lowerInAmount = first;
      lowerProfit = profitFirst;
    } else if (profitFirst.gt(lowerProfit)) {
      upperInAmount = second;
      upperProfit = profitSecond;
    } else {
      upperInAmount = first;
      upperProfit = profitFirst;
    }
    gap = upperInAmount.sub(lowerInAmount);
  }

  if (upperProfit.gt(lowerProfit)) {
    return {
      optimalAmountIn: upperInAmount,
      optimalProfit: upperProfit,
    };
  } else {
    return {
      optimalAmountIn: lowerInAmount,
      optimalProfit: lowerProfit,
    };
  }
};
