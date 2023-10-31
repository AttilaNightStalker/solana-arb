import { Connection, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ArbPathNode, DexSimulation } from "./dexSimulations/base";
import { WalletWithTokenMap, findOptimalTrade } from "./utils";
import { ArbProgram, ArbSwapStatePDA, ArbWallet } from "./singletons";
import { OrcaDexSimulation } from "./dexSimulations/orca";
import { RaydiumDexSimulation } from "./dexSimulations/raydium";
import { SaberDexSimulation } from "./dexSimulations/saber";
import { BN } from "@coral-xyz/anchor";
import { ConnectionPool } from "./connectionPool";
import fs from "fs";
import path from "path";

const getArbPathForToken = (
  tokenSymbol: string,
  dexSimulations: DexSimulation[],
  wallet: WalletWithTokenMap,
  maxLength: number = 3,
) => {
  const resultPaths: ArbPathNode[][] = [];

  const shouldIgnoreArbNode = (curPathStack: ArbPathNode[], targetArbNode: ArbPathNode) => {
    for (const node of curPathStack) {
      if (node.poolId === targetArbNode.poolId) {
        return true;
      }
    }
    return false;
  };

  const arbPathDfs = (curToken: string, arbStack: ArbPathNode[]) => {
    if (arbStack.length >= maxLength) {
      return;
    }

    for (const dexSimulation of dexSimulations) {
      const pairedTokens = dexSimulation.getPairedTokens(curToken);
      for (const pairedToken of pairedTokens) {
        const arbPathNodes = dexSimulation.getArbPaths(curToken, pairedToken, wallet);
        if (pairedToken === tokenSymbol) {
          for (const arbPathNode of arbPathNodes) {
            if (shouldIgnoreArbNode(arbStack, arbPathNode)) {
              continue;
            }
            resultPaths.push(arbStack.concat(arbPathNode));
          }
        }

        for (const arbPathNode of arbPathNodes) {
          if (shouldIgnoreArbNode(arbStack, arbPathNode)) {
            continue;
          }
          arbStack.push(arbPathNode);
          arbPathDfs(pairedToken, arbStack);
          arbStack.pop();
        }
      }
    }
  };

  arbPathDfs(tokenSymbol, []);
  return resultPaths;
};

const calculateArbPathAmoutout = (arbPath: ArbPathNode[], inAmount: BN) => {
  let curAmount = inAmount;
  for (const arbPathNode of arbPath) {
    curAmount = arbPathNode.getAmountOut(curAmount);
  }
  return curAmount;
};

const constructArbTransaction = async (
  arbPath: ArbPathNode[],
  inAmount: BN,
  arbWallet: WalletWithTokenMap,
  httpsConnection: Connection,
) => {
  if (!arbPath?.length) {
    return null;
  }

  const srcTokenSymbol = arbPath[0].fromToken;
  const arbSrcTokenAccount = arbWallet.getTokenAccountPubkey(srcTokenSymbol);

  const startSwapIx = ArbProgram.getInstance()
    .methods.startSwap(inAmount)
    .accounts({
      src: arbSrcTokenAccount,
      swapState: ArbSwapStatePDA.getInstance(),
    })
    .instruction();

  const profitOrRevertIx = ArbProgram.getInstance()
    .methods.profitOrRevert()
    .accounts({
      src: arbSrcTokenAccount,
      swapState: ArbSwapStatePDA.getInstance(),
    })
    .instruction();

  const swapIxSequence = arbPath.map((node) => node.getArbInstruction());

  const { blockhash: recentBlockhash, lastValidBlockHeight } =
    await httpsConnection.getLatestBlockhash("finalized");
  const messageV0 = new TransactionMessage({
    payerKey: ArbWallet.getInstance().publicKey,
    recentBlockhash,
    instructions: await Promise.all(
      [startSwapIx].concat(swapIxSequence).concat([profitOrRevertIx]),
    ),
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  tx.sign([ArbWallet.getInstance().payer]);

  return tx;
};

const formatPath = (arbPath: ArbPathNode[]) =>
  arbPath.map(
    (arbNode: ArbPathNode) => `${arbNode.poolId}:${arbNode.fromToken}->${arbNode.toToken}`,
  );

const tmpDirPath = "/Users/leqiang/Documents/crypto/trade/solana_arb_rs/contract/app/tmp";

const main = async () => {
  const done = new Promise((resolve) => {});
  const httpsConnection: Connection = new Connection(
    // "https://cosmopolitan-evocative-hexagon.solana-mainnet.discover.quiknode.pro/b740192c4a49942f1359bb902d54d15f3c1f2f8c/",
    "https://solana-mainnet.core.chainstack.com/c670533f4a6b33b655ff154ecbf7ae24",
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
  const arbWallet = await WalletWithTokenMap.create(
    connectionPool.getHttpsConnection().element,
    ArbWallet.getInstance(),
  );

  const orcaDexSimulation = new OrcaDexSimulation(
    connectionPool,
    "/Users/leqiang/Documents/crypto/trade/solana_arb_rs/contract/app/configs/whirlpools.json",
  );
  const raydiumDexSimulation = new RaydiumDexSimulation(
    connectionPool,
    "/Users/leqiang/Documents/crypto/trade/solana_arb_rs/contract/app/configs/raydiumAmmV3.json",
  );
  const saberDexSimulation = new SaberDexSimulation(
    connectionPool,
    "/Users/leqiang/Documents/crypto/trade/solana_arb_rs/contract/app/configs/stableswap.json",
  );

  for (const stablecoin of ["USDC", "USDT"]) {
    const arbPaths = getArbPathForToken(
      stablecoin,
      [orcaDexSimulation, raydiumDexSimulation, saberDexSimulation],
      arbWallet,
    );

    const pathFileOutput = arbPaths.map(formatPath);
    fs.writeFileSync(
      path.join(tmpDirPath, stablecoin + "_routes.json"),
      JSON.stringify(pathFileOutput),
    );

    const minAmountIn = new BN(1000000);
    const granularity = new BN(10000);
    const minProfit = new BN(1000);

    for (const arbPath of arbPaths) {
      for (const arbPathNode of arbPath) {
        await arbPathNode.activate();
        arbPathNode.registerUpdateCallback(async () => {
          const { optimalAmountIn, optimalProfit } = findOptimalTrade(
            minAmountIn,
            (amountIn: BN) => calculateArbPathAmoutout(arbPath, amountIn),
            granularity,
          );

          if (optimalProfit.gt(new BN(500))) {
            const arbTx = await constructArbTransaction(
              arbPath,
              optimalAmountIn,
              arbWallet,
              httpsConnection,
            );
            const txId = await httpsConnection.sendTransaction(arbTx, { skipPreflight: true });

            const profitLog = `profit ${JSON.stringify({
              path: formatPath(arbPath),
              optimalAmountIn: optimalAmountIn.toString(),
              optimalProfit: optimalProfit.toString(),
              timestamp: new Date().toLocaleString(),
              txId,
            })}\n`;

            console.log(profitLog);
            fs.appendFileSync(path.join(tmpDirPath, stablecoin + "_profit.txt"), profitLog);
          } else {
            console.log(
              `update ${JSON.stringify({
                path: formatPath(arbPath),
                optimalAmountIn: optimalAmountIn.toString(),
                optimalProfit: optimalProfit.toString(),
                timestamp: new Date().toLocaleString(),
              })}`,
            );
          }
        });
      }
    }
  }

  await done;
};

main();
