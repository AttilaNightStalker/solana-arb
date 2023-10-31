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
import IDL from "../idl/tmp.json";
import WhirlpoolIdl from "../idl/whirlpool.json";
import RaydiumAmmV3 from "../idl/raydiumAmmV3.json";
import { Program, Wallet, Idl } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import { Token } from "./types";
import { computeSwap } from "./3rdparty/whirlpools/sdk/src/quotes/swap/swap-manager";
import { OrcaDexSimulation } from "./dexSimulations/orca";
import { ArbProgram, ArbSwapStatePDA, ArbWallet, TokenInfoMap } from "./singletons";
import { WalletWithTokenMap } from "./utils";
import { ArbPathNode } from "./dexSimulations/base";
import { sleep } from "@lifinity/sdk-v2/lib/utils";
import { RaydiumDexSimulation } from "./dexSimulations/raydium";
import { decodeSwap } from "@saberhq/stableswap-sdk";
import { SaberDexSimulation } from "./dexSimulations/saber";
import { ConnectionPool } from "./connectionPool";
import {
  SYSTEM_PROGRAM_ID,
  TickArrayBitmapExtensionLayout,
  getPdaExBitmapAccount,
} from "@raydium-io/raydium-sdk";
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
  const httpsConnection: Connection = new Connection(
    "https://cosmopolitan-evocative-hexagon.solana-mainnet.discover.quiknode.pro/b740192c4a49942f1359bb902d54d15f3c1f2f8c/",
  );

  const wssConnection = new Connection(
    "https://solana-mainnet.core.chainstack.com/c670533f4a6b33b655ff154ecbf7ae24",
    {
      wsEndpoint: "wss://solana-mainnet.core.chainstack.com/ws/c670533f4a6b33b655ff154ecbf7ae24",
      commitment: "confirmed",
    },
  );

  const connectionPool = new ConnectionPool({
    wssConnections: [wssConnection],
    httpsConnections: [httpsConnection],
  });
  const orcaDexSimulation = new OrcaDexSimulation(
    connectionPool,
    "/Users/leqiang/Documents/crypto/trade/solana_arb_rs/contract/app/configs/whirlpools.json",
  );

  const arbWallet = await WalletWithTokenMap.create(
    connectionPool.getHttpsConnection().element,
    ArbWallet.getInstance(),
  );

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
  const programId = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
  const poolId = new PublicKey("2QdhepnKRTLjjSqPL1PtKNwqrUkoLee5Gqs8bvZhRdMv");
  const raydiumProgram = getProgram(RaydiumAmmV3 as Idl, programId);
  const connection: Connection = new Connection(
    "https://cosmopolitan-evocative-hexagon.solana-mainnet.discover.quiknode.pro/b740192c4a49942f1359bb902d54d15f3c1f2f8c/",
  );

  const { publicKey: tickArrayBitmapExtension } = getPdaExBitmapAccount(programId, poolId);
  const accountInfo = await connection.getAccountInfo(tickArrayBitmapExtension);
  const parsedAccountInfo = raydiumProgram.account.tickArrayBitmapExtension.coder.accounts.decode(
    "TickArrayBitmapExtension",
    accountInfo.data,
  );
  console.log({ parsedAccountInfo });

  for (const tickArray of (parsedAccountInfo as TickArrayBitmapExtensionLayout)
    .positiveTickArrayBitmap) {
    console.log(`possitive-${tickArray}`);
  }
  for (const tickArray of (parsedAccountInfo as TickArrayBitmapExtensionLayout)
    .negativeTickArrayBitmap) {
    console.log(`negative-${tickArray}`);
  }
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
  const httpsConnection: Connection = new Connection(
    "https://cosmopolitan-evocative-hexagon.solana-mainnet.discover.quiknode.pro/b740192c4a49942f1359bb902d54d15f3c1f2f8c/",
  );

  const wssConnection = new Connection(
    "https://solana-mainnet.core.chainstack.com/c670533f4a6b33b655ff154ecbf7ae24",
    {
      wsEndpoint: "wss://solana-mainnet.core.chainstack.com/ws/c670533f4a6b33b655ff154ecbf7ae24",
      commitment: "confirmed",
    },
  );

  const connectionPool = new ConnectionPool({
    wssConnections: [wssConnection],
    httpsConnections: [httpsConnection],
  });
  const raydiumDexConfig = new RaydiumDexSimulation(
    connectionPool,
    "/Users/leqiang/Documents/crypto/trade/solana_arb_rs/contract/app/configs/raydiumAmmV3.json",
  );

  const arbWallet = await WalletWithTokenMap.create(
    connectionPool.getHttpsConnection().element,
    ArbWallet.getInstance(),
  );

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
    const amountOut = path.getAmountOut(new anchor.BN("1"));
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

const testSaber = async () => {
  const httpsConnection: Connection = new Connection(
    "https://cosmopolitan-evocative-hexagon.solana-mainnet.discover.quiknode.pro/b740192c4a49942f1359bb902d54d15f3c1f2f8c/",
  );

  const wssConnection = new Connection(
    "https://solana-mainnet.core.chainstack.com/c670533f4a6b33b655ff154ecbf7ae24",
    {
      wsEndpoint: "wss://solana-mainnet.core.chainstack.com/ws/c670533f4a6b33b655ff154ecbf7ae24",
      commitment: "confirmed",
    },
  );

  const connectionPool = new ConnectionPool({
    wssConnections: [wssConnection],
    httpsConnections: [httpsConnection],
  });

  // const saberDex = new SaberDexSimulation(
  //   connectionPool,
  //   "/Users/leqiang/Documents/crypto/trade/solana_arb_rs/contract/app/configs/stableswap.json",
  // );
  // const arbWallet = await WalletWithTokenMap.create(
  //   connectionPool.getHttpsConnection().element,
  //   ArbWallet.getInstance(),
  // );

  const accountInfo = await connectionPool
    .getHttpsConnection()
    .element.getAccountInfo(new PublicKey("MARpDPs5A7XiyCWPNH8GsMWPLxmwNn9SBmKvPa9LzgA"));

  console.log(decodeSwap(accountInfo.data));

  return;
  // const tokenMap = TokenInfoMap.getSymbolMap();
  // const arbPath: ArbPathNode[] = [];
  // for (const [symbolA] of Object.entries(tokenMap)) {
  //   for (const [symbolB] of Object.entries(tokenMap)) {
  //     if (symbolA == symbolB) {
  //       continue;
  //     }
  //     const pairArbPath = await saberDex.getArbPaths(symbolA, symbolB, arbWallet);
  //     arbPath.push(...pairArbPath);
  //   }
  // }

  // for (const path of arbPath) {
  //   await path.activate();
  //   path.registerUpdateCallback(() => console.log(`updating ${path.fromToken}-${path.toToken}`));
  // }

  // for (const path of arbPath) {
  //   const amountOut = path.getAmountOut(new anchor.BN("10000000"));
  //   console.log(`${path.fromToken}-${path.toToken}=${amountOut}`);
  // }
};

const testTmp = async () => {
  const tmpProgram = ArbProgram.getInstance();
  // const txid = await tmpProgram.methods.initProgram().accounts({
  //   swapState: ArbSwapStatePDA.getInstance(),
  //   payer: ArbWallet.getInstance().publicKey,
  //   SystemProgram: SystemProgram.programId,
  // }).signers([ArbWallet.getInstance().payer]).rpc();

  // console.log({ txid });
  const swapState = await tmpProgram.account.swapState.fetch(ArbSwapStatePDA.getInstance());
  console.log({ swapState });

  const httpsConnection: Connection = new Connection(
    "https://cosmopolitan-evocative-hexagon.solana-mainnet.discover.quiknode.pro/b740192c4a49942f1359bb902d54d15f3c1f2f8c/",
  );

  const wssConnection = new Connection(
    "https://solana-mainnet.core.chainstack.com/c670533f4a6b33b655ff154ecbf7ae24",
    {
      wsEndpoint: "wss://solana-mainnet.core.chainstack.com/ws/c670533f4a6b33b655ff154ecbf7ae24",
      commitment: "confirmed",
    },
  );

  const connectionPool = new ConnectionPool({
    wssConnections: [wssConnection],
    httpsConnections: [httpsConnection],
  });

  const orcaDex = new OrcaDexSimulation(
    connectionPool,
    "/Users/leqiang/Documents/crypto/trade/solana_arb_rs/contract/app/configs/whirlpools.json",
  );
  const raydiumDex = new RaydiumDexSimulation(
    connectionPool,
    "/Users/leqiang/Documents/crypto/trade/solana_arb_rs/contract/app/configs/raydiumAmmV3.json",
  );
  const saberDex = new SaberDexSimulation(
    connectionPool,
    "/Users/leqiang/Documents/crypto/trade/solana_arb_rs/contract/app/configs/stableswap.json",
  );
  const arbWallet = await WalletWithTokenMap.create(
    connectionPool.getHttpsConnection().element,
    ArbWallet.getInstance(),
  );

  const pathNodes = raydiumDex.getArbPaths("SOL", "USDT", arbWallet);

  const start = new Date();
  const res = await connectionPool
    .getHttpsConnection()
    .element.getAccountInfo(new PublicKey("2QdhepnKRTLjjSqPL1PtKNwqrUkoLee5Gqs8bvZhRdMv"));
  console.log({ res, time: new Date().getTime() - start.getTime() });
  return;
  for (const node of pathNodes) {
    await node.activate();
    const outAmount = node.getAmountOut(new anchor.BN(1000000));
    console.log({ outAmount: outAmount.toString() });

    const preIx = await tmpProgram.methods
      .startSwap(new anchor.BN(1000000))
      .accounts({
        src: arbWallet.getTokenAccountPubkey(node.fromToken),
        swapState: ArbSwapStatePDA.getInstance(),
      })
      .instruction();

    const ix = await node.getArbInstruction();

    const { blockhash: recentBlockhash, lastValidBlockHeight } =
      await httpsConnection.getLatestBlockhash("finalized");
    const messageV0 = new TransactionMessage({
      payerKey: ArbWallet.getInstance().publicKey,
      recentBlockhash,
      instructions: [preIx, ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([ArbWallet.getInstance().payer]);
    const txid = await httpsConnection.sendTransaction(tx, { skipPreflight: true });
    // console.log({ txid });

    // const confirmation = await httpsConnection.confirmTransaction({
    //   signature: txid,
    //   blockhash: recentBlockhash,
    //   lastValidBlockHeight: lastValidBlockHeight,
    // });

    // console.log({ confirmation });
  }
};

// testTmp();
// testRaydium();
// testRaydiumAccount();
// testOrca();

// testSaber();
