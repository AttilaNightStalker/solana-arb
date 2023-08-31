import {
  AccountInfo,
  Connection,
  Context,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import IDL from "./idl/tmp.json";
import WhirlpoolIdl from "./idl/whirlpool.json";
import RaydiumAmmV3 from "./idl/raydiumAmmV3.json";
import { Program, Wallet, Idl } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import { Token } from "./types";
import { computeSwap } from "./3rdparty/whirlpools/sdk/src/quotes/swap/swap-manager";
import { OrcaDexSimulation } from "./dexSimulations/orca";
import { ArbProgram, ArbWallet, TokenInfoMap } from "./singletons";
import { WalletWithTokenMap } from "./utils";
import { ArbPathNode } from "./dexSimulations/base";
import { sleep } from "@lifinity/sdk-v2/lib/utils";
import { RaydiumDexSimulation } from "./dexSimulations/raydium";
// import { getAmountOut, AmountOut } from '@lifinity/sdk-v2';

const getSwapStatePubkey = (programPubkey: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("swap_state", "utf-8")], programPubkey);

const getProgram = (idl: Idl, programPubkey: PublicKey) => {
  const connection: Connection = new Connection(
    "https://cosmopolitan-evocative-hexagon.solana-mainnet.discover.quiknode.pro/b740192c4a49942f1359bb902d54d15f3c1f2f8c/",
  );

  connection.getTokenAccountsByOwner;
  const walletPrivateKey = Uint8Array.from(
    JSON.parse(fs.readFileSync("/Users/leqiang/.config/solana/id.json", "utf-8")),
  );
  const wallet = new Wallet(Keypair.fromSecretKey(walletPrivateKey));
  const programPrivateKey = Uint8Array.from(
    JSON.parse(fs.readFileSync("/Users/leqiang/.config/solana/program_id.json", "utf-8")),
  );
  const programKeypair = Keypair.fromSecretKey(programPrivateKey);

  const provider = new anchor.AnchorProvider(connection, wallet, {
    skipPreflight: false,
    commitment: "finalized",
  });

  return new Program(idl, programPubkey, provider);
};

const getTmpProgram = () => {
  const programPrivateKey = Uint8Array.from(
    JSON.parse(fs.readFileSync("/Users/leqiang/.config/solana/program_id.json", "utf-8")),
  );
  const programKeypair = Keypair.fromSecretKey(programPrivateKey);

  return getProgram(IDL as Idl, programKeypair.publicKey);
};

const testSwapData = async () => {
  const program = getTmpProgram();
  const [swapStatePubkey, _] = getSwapStatePubkey(program.programId);
  const swapStateAccount = await program.account.swapState.fetch(swapStatePubkey, "confirmed");
  console.log(swapStateAccount);

  const res = await program.methods
    .initProgram()
    .accounts({
      swapState: swapStatePubkey,
      payer: program.provider.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([])
    .simulate({ commitment: "finalized" });

  console.log(res);
};

const loadTokenConfigMap = () => {
  const configJson: any[] = JSON.parse(
    fs.readFileSync(
      "/Users/leqiang/Documents/crypto/trade/solana_arb_rs/contract/app/configs/tokens.json",
      "utf-8",
    ),
  );

  const result: Record<string, Token> = {};
  for (const tokenInfo of configJson) {
    const { symbol, mint, decimals } = tokenInfo;
    result[symbol] = {
      symbol,
      mint: new PublicKey(mint),
      decimals: parseInt(decimals),
    };
  }
  return result;
};

const testLifinity = () => {
  // getAmountOut()
};

const delay = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const testOrca = async () => {
  const done = new Promise((resolve) => {});
  const conneciton = new Connection(
    "https://solana-mainnet.core.chainstack.com/c670533f4a6b33b655ff154ecbf7ae24",
    {
      wsEndpoint: "wss://solana-mainnet.core.chainstack.com/ws/c670533f4a6b33b655ff154ecbf7ae24",
      commitment: "confirmed",
    },
  );
  const orcaDexSimulation = new OrcaDexSimulation(
    conneciton,
    "/Users/leqiang/Documents/crypto/trade/solana_arb_rs/contract/app/configs/whirlpools.json",
  );

  const arbWallet = await WalletWithTokenMap.create(conneciton, ArbWallet.getInstance());

  const tokenMap = TokenInfoMap.getSymbolMap();
  const arbPath: ArbPathNode[] = [];
  for (const [symbolA] of Object.entries(tokenMap)) {
    for (const [symbolB] of Object.entries(tokenMap)) {
      if (symbolA == symbolB) {
        continue;
      }
      const pairArbPath = await orcaDexSimulation.getArbPaths(symbolA, symbolB, arbWallet);
      arbPath.push(...pairArbPath);
    }
  }

  for (const path of arbPath) {
    await path.activate();
    path.registerUpdateCallback(() => console.log(`updating ${path.fromToken}-${path.toToken}`));
  }

  // const localConnection = new Connection("http://127.0.0.1:8899");
  // const arbProgram = ArbProgram.getInstance();
  for (const path of arbPath) {
    const amountOut = path.getAmountOut(new anchor.BN("100000000"));
    console.log(`${path.fromToken}-${path.toToken}=${amountOut}`);
    // const initSwapStart = await arbProgram.methods.initProgram().accounts({
    //   swapState: arbProgram.swapStatePubkey,
    //   payer: arbWallet.publicKey,
    //   systemProgram: SystemProgram.programId,
    // }).instruction();

    // const swapStartix = await arbProgram.methods.startSwap(100000).accounts({
    //   src: arbWallet.getTokenAccountPubkey(path.fromToken),
    //   swapState: arbProgram.swapStatePubkey,
    // }).instruction();

    // const { blockhash } = await localConnection.getLatestBlockhash();
    // const messageV0 = new TransactionMessage({
    //   payerKey: arbWallet.publicKey,
    //   recentBlockhash: blockhash,
    //   instructions: [
    //     // initSwapStart
    //     // swapStartix,
    //     path.arbInstruction,
    //   ]
    // }).compileToV0Message();

    // const tx = new VersionedTransaction(messageV0);
    // tx.sign([arbWallet.payer]);
    // console.log({payer: arbWallet.payer.publicKey.toString()})
    // console.log({program: arbProgram.programId.toString()})
    // const txid = await localConnection.sendTransaction(tx);
    // console.log({txid});
  }

  console.log("started paths");
  await done;
};

const testRaydiumAccount = async () => {
  const raydiumProgram = getProgram(
    RaydiumAmmV3 as Idl,
    new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"),
  );
  const connection: Connection = new Connection(
    "https://cosmopolitan-evocative-hexagon.solana-mainnet.discover.quiknode.pro/b740192c4a49942f1359bb902d54d15f3c1f2f8c/",
  );

  const accountInfo = await connection.getAccountInfo(
    new PublicKey("HfERMT5DRA6C1TAqecrJQFpmkf3wsWTMncqnj3RDg5aw"),
  );
  const parsedAccountInfo = raydiumProgram.account.ammConfig.coder.accounts.decode(
    "AmmConfig",
    accountInfo.data,
  );
  console.log({ parsedAccountInfo });

  // const poolaccountinfo = await connection.getAccountInfo(
  //   new PublicKey("2QdhepnKRTLjjSqPL1PtKNwqrUkoLee5Gqs8bvZhRdMv"),
  // );
  // const poolparsedAccountInfo = raydiumProgram.account.tickArrayState.coder.accounts.decode(
  //   "PoolState",
  //   poolaccountinfo.data,
  // );
  // console.log({ poolparsedAccountInfo });
};

const testRaydium = async () => {
  const done = new Promise((resolve) => {});
  const conneciton = new Connection(
    "https://solana-mainnet.core.chainstack.com/c670533f4a6b33b655ff154ecbf7ae24",
    {
      wsEndpoint: "wss://solana-mainnet.core.chainstack.com/ws/c670533f4a6b33b655ff154ecbf7ae24",
      commitment: "confirmed",
    },
  );
  const raydiumDexConfig = new RaydiumDexSimulation(
    conneciton,
    "/Users/leqiang/Documents/crypto/trade/solana_arb_rs/contract/app/configs/raydiumAmmV3.json",
  );

  const arbWallet = await WalletWithTokenMap.create(conneciton, ArbWallet.getInstance());

  const tokenMap = TokenInfoMap.getSymbolMap();
  const arbPath: ArbPathNode[] = [];
  for (const [symbolA] of Object.entries(tokenMap)) {
    for (const [symbolB] of Object.entries(tokenMap)) {
      if (symbolA == symbolB) {
        continue;
      }
      const pairArbPath = await raydiumDexConfig.getArbPaths(symbolA, symbolB, arbWallet);
      arbPath.push(...pairArbPath);
    }
  }

  for (const path of arbPath) {
    await path.activate();
    path.registerUpdateCallback(() => console.log(`updating ${path.fromToken}-${path.toToken}`));
  }

  // const localConnection = new Connection("http://127.0.0.1:8899");
  // const arbProgram = ArbProgram.getInstance();
  for (const path of arbPath) {
    const amountOut = path.getAmountOut(new anchor.BN("10000000"));
    console.log(`${path.fromToken}-${path.toToken}=${amountOut}`);
    // const initSwapStart = await arbProgram.methods.initProgram().accounts({
    //   swapState: arbProgram.swapStatePubkey,
    //   payer: arbWallet.publicKey,
    //   systemProgram: SystemProgram.programId,
    // }).instruction();

    // const swapStartix = await arbProgram.methods.startSwap(100000).accounts({
    //   src: arbWallet.getTokenAccountPubkey(path.fromToken),
    //   swapState: arbProgram.swapStatePubkey,
    // }).instruction();

    // const { blockhash } = await localConnection.getLatestBlockhash();
    // const messageV0 = new TransactionMessage({
    //   payerKey: arbWallet.publicKey,
    //   recentBlockhash: blockhash,
    //   instructions: [
    //     // initSwapStart
    //     // swapStartix,
    //     path.arbInstruction,
    //   ]
    // }).compileToV0Message();

    // const tx = new VersionedTransaction(messageV0);
    // tx.sign([arbWallet.payer]);
    // console.log({payer: arbWallet.payer.publicKey.toString()})
    // console.log({program: arbProgram.programId.toString()})
    // const txid = await localConnection.sendTransaction(tx);
    // console.log({txid});
  }

  console.log("started paths");
  await done;
};

testRaydium();
// testRaydiumAccount();
// testOrca();
