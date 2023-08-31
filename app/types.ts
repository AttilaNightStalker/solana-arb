import { PublicKey } from "@solana/web3.js";

export type Token = {
  symbol: string;
  mint: PublicKey;
  decimals: number;
};

export type WalletTokenAccount = {
  token: Token;
  accountPubkey: PublicKey;
  ownerPubkey: PublicKey;
};

export type TickArrayPDASet = {
  curTickArray: PublicKey;
  skipPrevTickArrayIndex: PublicKey;
  prevTickArrayIndex: PublicKey;
  nextTickArrayIndex: PublicKey;
  skipNextTickArrayIndex: PublicKey;
};
