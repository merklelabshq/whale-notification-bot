import { BorshCoder } from "@project-serum/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { configDotenv } from "dotenv";
import { ammProgram, dlmmProgram, messageQueues, messageTimestamps } from "..";
import { ammIDL, dlmmIDL } from "../idls";
import Token from "../models/token";
import TxnSignature from "../models/txnSignature";
import connectToDatabase from "./database";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
configDotenv();

const dexscreenerUrl = "https://dexscreener.com/solana/";
const jupiterUrl = "https://jup.ag/swap/USDC-";
const txnUrl = "https://solscan.io/tx/";
const buyerUrl = "https://solscan.io/account/";
const dexTUrl = "https://www.dextools.io/app/en/solana/pair-explorer/";
const solTrendingUrl = "https://t.me/SOLTRENDING";

type Instruction = {
  programId: string;
  accounts: string[];
  data: string;
};

type Swap = {
  destination: string;
  source: string;
  amount: string;
};

//Fetch token price from jupipter or birdseye
const getTokenPrice = async (tokenMint: string) => {
  try {
    async function fetchTokenPrice(tokenMint: string) {
      const url = `https://price.jup.ag/v6/price?ids=${tokenMint},SOL`;
      let attempts = 0;
      const maxAttempts = 5;

      while (attempts < maxAttempts) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const tokenPriceResult: any = await fetch(url).then((res) =>
            res.json()
          );
          if (!tokenPriceResult.data[tokenMint]) {
            throw new Error("Token price not found");
          }
          return tokenPriceResult;
        } catch (error: any) {
          attempts++;
          if (attempts >= maxAttempts) {
            throw new Error(
              `Failed to fetch token price after ${maxAttempts} attempts: ${error.message}`
            );
          }
          console.log(`Attempt ${attempts} failed. Retrying...`);
        }
      }
    }

    let tokenPrice: number,
      solPrice: number = 0;
    try {
      const tokenPriceResult = await fetchTokenPrice(tokenMint);
      solPrice = tokenPriceResult.data.SOL.price;

      if (!tokenPriceResult.data[tokenMint])
        throw new Error("SOL price found, token price not found");
      tokenPrice = tokenPriceResult.data[tokenMint].price;
    } catch (error: any) {
      const options = {
        method: "GET",
        headers: { "X-API-KEY": process.env.BIRDSEYE_API_KEY! },
      };
      const data: any = await fetch(
        `https://public-api.birdeye.so/defi/price?address=${tokenMint}`,
        options
      ).then((res) => res.json());

      tokenPrice = data.data.value;

      if (!solPrice) {
        const data: any = await fetch(
          `https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112`,
          options
        ).then((res) => res.json());
        solPrice = data.data.value;
      }
    }

    return { tokenPrice, solPrice };
  } catch (error: any) {
    console.log("Error in getTokenPrice", error.message);
    return { tokenPrice: 0, solPrice: 0 };
  }
};

//Fetch total supply of token
const getTotalSupply = async (tokenMint: string) => {
  try {
    const connection = new Connection(process.env.BACKEND_RPC!);

    const accountInfoResult: any = await connection.getParsedAccountInfo(
      new PublicKey(tokenMint)
    );

    if (!accountInfoResult.value) {
      console.log("accountInfoResult", accountInfoResult);
      throw new Error("Account info not found");
    }

    const accountInfo = (accountInfoResult.value?.data as any).parsed.info;
    const decimals = accountInfo.decimals;
    const totalSupply = parseInt(accountInfo.supply) / 10 ** decimals;

    if (!totalSupply) throw new Error("Total supply not found");
    return totalSupply;
  } catch (error: any) {
    console.log("Error in getTotalSupply", error.message);
    return 0;
  }
};

type InnerInstruction = {
  index: number;
  instructions: {
    program: string;
    programId: string;
    parsed?: {
      info: {
        authority: string;
        destination: string;
        mint: string;
        source: string;
        amount: string;
        tokenAmount: {
          amount: string;
          decimals: number;
          uiAmount: number;
          uiAmountString: string;
        };
      };
      type: string;
    };
    data?: string;
    stackHeight: number;
  }[];
};

const handleDlmm = (
  instructions: Instruction[],
  innerInstructions: InnerInstruction[]
) => {
  const coder = new BorshCoder(dlmmIDL);

  const swaps: Array<Swap> = [];

  const processInnerInstructions = (
    innerInstructions: InnerInstruction[],
    index: number
  ) => {
    const innerInstruction = innerInstructions.find(
      (innerInstruction) => innerInstruction.index === index
    );

    if (!innerInstruction) return;

    for (
      let j = 0, transferCount = 0;
      j < innerInstruction.instructions.length && transferCount < 2;
      j++
    ) {
      const ix = innerInstruction.instructions[j];
      if (
        ix.programId !== TOKEN_PROGRAM_ID.toBase58() ||
        ix.parsed?.type !== "transferChecked" ||
        !ix.parsed?.info
      )
        continue;

      const { destination, source, tokenAmount } = ix.parsed.info;

      swaps.push({
        destination,
        source,
        amount: tokenAmount!.amount,
      });

      transferCount++;
    }
  };

  for (let i = 0; i < instructions.length; i++) {
    const instruction = instructions[i];

    if (instruction.programId !== dlmmProgram) continue;

    const decodedIx = coder.instruction.decode(instruction.data, "base58");

    if (decodedIx?.name !== "swap") continue;

    processInnerInstructions(innerInstructions, i);
  }

  for (let i = 0; i < innerInstructions.length; i++) {
    const innerInstruction = innerInstructions[i];
    const ixs = innerInstruction.instructions;

    let isSwap = false;
    let stackHeight = 0;

    for (
      let j = 0, transferCount = 0;
      j < ixs.length && transferCount < 2;
      j++
    ) {
      const ix = ixs[j];

      if (!isSwap) {
        if (ix.programId !== dlmmProgram || !ix.data) continue;

        const decodedIx = coder.instruction.decode(ix.data, "base58");
        if (decodedIx?.name !== "swap") continue;
        isSwap = true;
        stackHeight = ix.stackHeight + 1;
      } else {
        if (
          ix.programId !== TOKEN_PROGRAM_ID.toBase58() ||
          ix.parsed?.type !== "transferChecked" ||
          ix.stackHeight !== stackHeight
        )
          continue;

        const { destination, source, tokenAmount } = ix.parsed.info;

        swaps.push({
          destination,
          source,
          amount: tokenAmount!.amount,
        });

        transferCount++;
      }
    }
  }

  return swaps;
};

const handleAmm = async (
  instructions: Instruction[],
  innerInstructions: InnerInstruction[]
) => {
  const coder = new BorshCoder(ammIDL);

  const swaps: Array<Swap> = [];

  const processInnerInstructions = async (
    innerInstructions: InnerInstruction[],
    index: number,
    stackHeightOffset: number
  ) => {
    const innerInstruction = innerInstructions.find(
      (innerInstruction) => innerInstruction.index === index
    );

    if (!innerInstruction) return;

    for (
      let j = 0, transferCount = 0;
      j < innerInstruction.instructions.length && transferCount < 2;
      j++
    ) {
      const ix = innerInstruction.instructions[j];
      if (
        ix.parsed?.type !== "transfer" ||
        ix.stackHeight !== stackHeightOffset
      )
        continue;

      const { destination, source, amount } = ix.parsed.info;

      swaps.push({
        destination,
        source,
        amount,
      });

      transferCount++;
    }
  };

  for (let i = 0; i < instructions.length; i++) {
    const instruction = instructions[i];

    if (instruction.programId !== ammProgram) continue;

    const decodedIx = coder.instruction.decode(instruction.data, "base58");
    if (decodedIx?.name !== "swap") continue;

    await processInnerInstructions(innerInstructions, i, 3);
  }

  for (let i = 0; i < innerInstructions.length; i++) {
    const innerInstruction = innerInstructions[i];
    const ixs = innerInstruction.instructions;

    let isSwap = false;
    let stackHeight = 0;

    for (
      let j = 0, transferCount = 0;
      j < ixs.length && transferCount < 2;
      j++
    ) {
      const ix = ixs[j];

      if (!isSwap) {
        if (ix.programId !== ammProgram || !ix.data) continue;

        const decodedIx = coder.instruction.decode(ix.data, "base58");
        if (decodedIx?.name !== "swap") continue;
        isSwap = true;
        stackHeight = ix.stackHeight + 2;
      } else {
        if (ix.parsed?.type !== "transfer" || ix.stackHeight !== stackHeight)
          continue;

        const { destination, source, amount } = ix.parsed.info;

        swaps.push({
          destination,
          source,
          amount,
        });

        transferCount++;
      }
    }
  }

  return swaps;
};

const getSwaps = async (transaction: any) => {
  try {
    const instructions = transaction.transaction.message.instructions;
    const innerInstructions = transaction.meta.innerInstructions;

    const lbClmmSwaps = handleDlmm(instructions, innerInstructions);

    // Usage for handleAmm
    const ammSwaps = await handleAmm(instructions, innerInstructions);

    return [...lbClmmSwaps, ...ammSwaps];
  } catch (error: any) {
    console.log("Error in getSwaps", error.message);
    return [];
  }
};

const isMeteoraSwap = (logMessages: string[]) => {
  return logMessages.some(
    (message, index) =>
      index > 0 &&
      (logMessages[index - 1].includes(
        "Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo invoke"
      ) ||
        logMessages[index - 1].includes(
          "Program Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB invoke"
        )) &&
      message === "Program log: Instruction: Swap"
  );
};

const getTokenChanges = (data: any) => {
  const meta = data.transaction.meta;
  const accountKeys = data.transaction.transaction.message.accountKeys;

  const tokenChanges: Record<
    string,
    {
      owner: string;
      mint: string;
      decimals: number;
      isNewHolder: boolean;
      amount: number;
      initialAmount: number;
    }
  > = {};

  const preTokenBalances = meta.preTokenBalances;
  const postTokenBalances = meta.postTokenBalances;

  for (let i = 0; i < postTokenBalances.length; i++) {
    const postTokenBalance = postTokenBalances[i];
    const preTokenBalance = preTokenBalances.find(
      (t: any) => t.accountIndex === postTokenBalance.accountIndex
    );

    const tokenAccount = accountKeys[postTokenBalance.accountIndex].pubkey;
    const mint = postTokenBalance.mint;
    const owner = postTokenBalance.owner;
    const decimals = postTokenBalance.uiTokenAmount.decimals;

    const preTokenAmount = preTokenBalance?.uiTokenAmount?.uiAmount ?? 0;
    const postTokenAmount = postTokenBalance.uiTokenAmount.uiAmount;

    if (preTokenAmount >= postTokenAmount) continue;

    const isNewHolder = preTokenAmount === 0;
    const amount = postTokenAmount - preTokenAmount;

    tokenChanges[tokenAccount] = {
      owner,
      mint,
      decimals,
      isNewHolder,
      amount,
      initialAmount: preTokenAmount,
    };
  }

  return tokenChanges;
};

const callback = async (data: any) => {
  try {
    if (data.transaction.meta.err) return;

    const txnSignature = data.signature;

    await connectToDatabase();
    try {
      await TxnSignature.create({ txnSignature });
    } catch (error: any) {
      if (error.code !== 11000) console.log(txnSignature, error.message);
      return;
    }

    const logMessages: string[] = data.transaction.meta.logMessages;

    // Just a preliminary check to see if it's a Meteora swap
    const meteoraSwapFound = isMeteoraSwap(logMessages);
    if (!meteoraSwapFound) return;

    if (!data.transaction.transaction) {
      console.log("data.transaction.transaction not found", data);
      return;
    }
    const signer = data.transaction.transaction.message.accountKeys.find(
      (acc: any) => acc.signer
    ).pubkey;

    const tokenChanges = getTokenChanges(data);

    const userSwaps = await getSwaps(data.transaction).then((swaps) =>
      swaps.reduce(
        (acc, swap) => {
          const { destination, amount } = swap;

          if (!tokenChanges[destination]) return acc;

          const { owner, decimals, mint, isNewHolder, initialAmount } =
            tokenChanges[destination];

          const uiAmount = parseInt(amount) / 10 ** decimals;

          acc.push({
            mint,
            destination,
            authority: owner,
            uiAmount,
            isNewHolder,
            positionIncrease: initialAmount
              ? ((uiAmount + initialAmount) * 100) / initialAmount
              : 0,
          });

          return acc;
        },
        [] as Array<{
          mint: string;
          destination: string;
          authority: string;
          uiAmount: number;
          isNewHolder: boolean;
          positionIncrease: number;
        }>
      )
    );

    const listeningGroups = await Token.find({
      tokenMint: { $in: userSwaps.map((swap) => swap.mint) },
    }).lean();

    for (let i = 0; i < listeningGroups.length; i++) {
      const listeningGroup = listeningGroups[i];
      const tokenMint = listeningGroup.tokenMint;

      const swaps = userSwaps.filter((swap) => swap.mint === tokenMint);

      const { tokenPrice, solPrice } = await getTokenPrice(tokenMint);

      for (let j = 0; j < swaps.length; j++) {
        const swap = swaps[j];

        if (swap.uiAmount * tokenPrice < listeningGroup.minValue) {
          continue;
        }

        const totalSupply = await getTotalSupply(tokenMint);
        const marketCap = Math.floor(totalSupply * tokenPrice).toLocaleString();

        let { groupId, image, name, symbol, minValue, emojis, poolAddress } =
          listeningGroup;

        // Stock image if no image is provided
        image =
          image ||
          "https://static.vecteezy.com/system/resources/previews/006/153/238/original/solana-sol-logo-crypto-currency-purple-theme-background-neon-design-vector.jpg";

        const amount = swap.uiAmount.toFixed(2);
        const positionIncrease = swap.positionIncrease.toFixed(2);
        const spentUsd = (swap.uiAmount * tokenPrice).toFixed(2);
        const spentSol = (parseFloat(spentUsd) / solPrice).toFixed(2);

        let caption =
          `*${name.toUpperCase()} Buy!*\n` +
          "__emojis__\n\n" +
          `🔀 Spent *$${spentUsd} (${spentSol} SOL)*\n` +
          `🔀 Got *${amount} ${symbol}*\n` +
          `👤 [Buyer](${buyerUrl}${signer}) / [Txn](${txnUrl}${txnSignature})\n` +
          `🪙 *${
            swap.isNewHolder ? "New Holder" : `Position +${positionIncrease}%`
          }*\n` +
          `💸 Market Cap *$${marketCap}*\n\n` +
          `[Screener](${dexscreenerUrl}${poolAddress}) |` +
          ` [DexT](${dexTUrl}${poolAddress}) |` +
          ` [Buy](${jupiterUrl}${tokenMint})`;

        let remainingLength = 1024 - caption.length;
        remainingLength -= remainingLength % emojis.length;

        let totalEmojis = "";
        const times = Math.min(
          Math.floor(parseFloat(spentUsd) / minValue),
          remainingLength / emojis.length
        );
        for (let i = 0; i < times; i++) totalEmojis += emojis;

        caption = caption.replace("__emojis__", totalEmojis);

        // Add to message queue of the respective group
        if (!messageQueues[groupId]) {
          messageQueues[groupId] = [];
        }

        if (!messageTimestamps[groupId]) {
          messageTimestamps[groupId] = [];
        }

        messageQueues[groupId].push({
          image,
          caption,
        });
      }
    }
    return;
  } catch (error: any) {
    console.error(error.message);
    return;
  }
};

export default callback;
