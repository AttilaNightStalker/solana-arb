import { Idl, Program, Wallet, AnchorProvider } from "@coral-xyz/anchor";
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
