import { setTimeout as delay } from "node:timers/promises";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  http,
  keccak256,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { arcTestnet } from "viem/chains";

// ─── Wallet config (reusing existing ERC-8183 wallets) ─────────────────────

const CLIENT_WALLET = {
  id:      "fef51e10-d568-5c18-b146-9d53a44c1ae7",
  address: "0xc7c43433c8b13d6fc7a0d96574d05526ce34db18" as Address,
};

const PROVIDER_WALLET = {
  id:      "f3533ffb-2c88-5fba-bd2f-b0772db4dc54",
  address: "0x604d283252cc8d13832a52a1171afecea290a9f2" as Address,
};

// ─── Contract addresses ────────────────────────────────────────────────────

const AGENTIC_COMMERCE_CONTRACT =
  "0x0747EEf0706327138c69792bF28Cd525089e4583" as Address;

const USDC_CONTRACT =
  "0x3600000000000000000000000000000000000000" as Address;

// ─── Job definitions ───────────────────────────────────────────────────────
// Add or remove jobs as needed. Each runs as a full ERC-8183 lifecycle.

const JOBS = [
  {
    description: "Market data analysis: fetch and summarize DEX liquidity across Arc Testnet pools",
    budget: "2",
    deliverable: "market-analysis-report-v1",
  },
  {
    description: "Smart contract audit: review ERC-8004 identity registry for reentrancy vulnerabilities",
    budget: "2",
    deliverable: "audit-report-erc8004-v1",
  },
  {
    description: "Cross-chain arbitrage detection: identify price discrepancies between Arc and Ethereum testnets",
    budget: "3",
    deliverable: "arbitrage-opportunities-report-v1",
  },
  {
    description: "Wallet activity report: aggregate onchain transactions for compliance reporting on Arc Testnet",
    budget: "2",
    deliverable: "compliance-wallet-report-v1",
  },
  {
    description: "USDC yield optimization: evaluate staking and lending protocols available on Arc Testnet",
    budget: "3",
    deliverable: "yield-optimization-report-v1",
  },
  {
    description: "Agent reputation scoring: build a scoring model for ERC-8004 agents based on onchain feedback",
    budget: "3",
    deliverable: "agent-reputation-model-v1",
  },
  {
    description: "NFT metadata validation: verify IPFS metadata integrity for identity NFTs on Arc Testnet",
    budget: "2",
    deliverable: "nft-metadata-validation-report-v1",
  },
  {
    description: "Gas optimization: profile transaction costs for ERC-8183 job lifecycle on Arc Testnet",
    budget: "3",
    deliverable: "gas-optimization-report-v1",
  },
  {
    description: "StableFX rate monitoring: track USDC/EURC exchange rates on Arc Testnet over 24 hours",
    budget: "3",
    deliverable: "stablefx-rate-report-v1",
  },
  {
    description: "Onchain KYC verification: validate agent credentials via ERC-8004 ValidationRegistry",
    budget: "2",
    deliverable: "kyc-verification-report-v1",
  },
];

// ─── ABI ───────────────────────────────────────────────────────────────────

const agenticCommerceAbi = [
  {
    type: "function", name: "createJob", stateMutability: "nonpayable",
    inputs: [
      { name: "provider",    type: "address" },
      { name: "evaluator",   type: "address" },
      { name: "expiredAt",   type: "uint256" },
      { name: "description", type: "string"  },
      { name: "hook",        type: "address" },
    ],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    type: "function", name: "setBudget", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",     type: "uint256" },
      { name: "amount",    type: "uint256" },
      { name: "optParams", type: "bytes"   },
    ],
    outputs: [],
  },
  {
    type: "function", name: "fund", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",     type: "uint256" },
      { name: "optParams", type: "bytes"   },
    ],
    outputs: [],
  },
  {
    type: "function", name: "submit", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",       type: "uint256" },
      { name: "deliverable", type: "bytes32" },
      { name: "optParams",   type: "bytes"   },
    ],
    outputs: [],
  },
  {
    type: "function", name: "complete", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",     type: "uint256" },
      { name: "reason",    type: "bytes32" },
      { name: "optParams", type: "bytes"   },
    ],
    outputs: [],
  },
  {
    type: "function", name: "getJob", stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "id",          type: "uint256" },
          { name: "client",      type: "address" },
          { name: "provider",    type: "address" },
          { name: "evaluator",   type: "address" },
          { name: "description", type: "string"  },
          { name: "budget",      type: "uint256" },
          { name: "expiredAt",   type: "uint256" },
          { name: "status",      type: "uint8"   },
          { name: "hook",        type: "address" },
        ],
      },
    ],
  },
  {
    type: "event", name: "JobCreated", anonymous: false,
    inputs: [
      { indexed: true,  name: "jobId",     type: "uint256" },
      { indexed: true,  name: "client",    type: "address" },
      { indexed: true,  name: "provider",  type: "address" },
      { indexed: false, name: "evaluator", type: "address" },
      { indexed: false, name: "expiredAt", type: "uint256" },
      { indexed: false, name: "hook",      type: "address" },
    ],
  },
] as const;

// ─── Clients ───────────────────────────────────────────────────────────────

const circleClient = initiateDeveloperControlledWalletsClient({
  apiKey:       process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(),
});

// ─── Helpers ───────────────────────────────────────────────────────────────

async function pollTx(id: string, label: string): Promise<Hex> {
  process.stdout.write(`    ⏳ ${label}`);
  for (let i = 0; i < 60; i++) {
    await delay(2000);
    const { data } = await circleClient.getTransaction({ id });
    const tx = data?.transaction;
    if (tx?.state === "COMPLETE") {
      if (!tx.txHash) throw new Error(`${label} completed but txHash is missing`);
      console.log(` ✅`);
      return tx.txHash as Hex;
    }
    if (tx?.state === "FAILED") throw new Error(`${label} failed onchain`);
    process.stdout.write(".");
  }
  throw new Error(`${label} timed out`);
}

async function extractJobId(txHash: Hex): Promise<bigint> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: agenticCommerceAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "JobCreated") return decoded.args.jobId;
    } catch { continue; }
  }
  throw new Error("Could not parse JobCreated event");
}

async function getUsdcBalance(walletId: string): Promise<string> {
  const balances = await circleClient.getWalletTokenBalance({ id: walletId });
  const usdc = balances.data?.tokenBalances?.find((b) => b.token?.symbol === "USDC");
  return usdc?.amount ?? "0";
}

// ─── Single job lifecycle ──────────────────────────────────────────────────

async function runJob(
  index: number,
  description: string,
  budgetUsdc: string,
  deliverableTag: string,
): Promise<void> {
  const budget    = parseUnits(budgetUsdc, 6);
  const jobLabel  = `Job ${index + 1}/${JOBS.length}`;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`📋 ${jobLabel}: ${description}`);
  console.log(`   Budget: ${budgetUsdc} USDC`);
  console.log(`${"─".repeat(60)}`);

  // 1. Create job
  const now       = await publicClient.getBlock();
  const expiredAt = now.timestamp + 3600n;

  const createTx = await circleClient.createContractExecutionTransaction({
    walletAddress:        CLIENT_WALLET.address,
    blockchain:           "ARC-TESTNET",
    contractAddress:      AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: "createJob(address,address,uint256,string,address)",
    abiParameters: [
      PROVIDER_WALLET.address,
      CLIENT_WALLET.address,
      expiredAt.toString(),
      description,
      "0x0000000000000000000000000000000000000000",
    ],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!createTx.data?.id) throw new Error("createJob tx failed to submit");
  const createHash = await pollTx(createTx.data.id, "createJob");
  const jobId      = await extractJobId(createHash);
  console.log(`    Job ID: ${jobId}`);

  // 2. Set budget (provider)
  const setBudgetTx = await circleClient.createContractExecutionTransaction({
    walletAddress:        PROVIDER_WALLET.address,
    blockchain:           "ARC-TESTNET",
    contractAddress:      AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: "setBudget(uint256,uint256,bytes)",
    abiParameters:        [jobId.toString(), budget.toString(), "0x"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!setBudgetTx.data?.id) throw new Error("setBudget tx failed to submit");
  await pollTx(setBudgetTx.data.id, "setBudget");

  // 3. Approve USDC (client)
  const approveTx = await circleClient.createContractExecutionTransaction({
    walletAddress:        CLIENT_WALLET.address,
    blockchain:           "ARC-TESTNET",
    contractAddress:      USDC_CONTRACT,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters:        [AGENTIC_COMMERCE_CONTRACT, budget.toString()],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!approveTx.data?.id) throw new Error("approve tx failed to submit");
  await pollTx(approveTx.data.id, "approve USDC");

  // 4. Fund escrow (client)
  const fundTx = await circleClient.createContractExecutionTransaction({
    walletAddress:        CLIENT_WALLET.address,
    blockchain:           "ARC-TESTNET",
    contractAddress:      AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: "fund(uint256,bytes)",
    abiParameters:        [jobId.toString(), "0x"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!fundTx.data?.id) throw new Error("fund tx failed to submit");
  await pollTx(fundTx.data.id, "fund escrow");

  // 5. Submit deliverable (provider)
  const deliverableHash = keccak256(toHex(deliverableTag));
  const submitTx = await circleClient.createContractExecutionTransaction({
    walletAddress:        PROVIDER_WALLET.address,
    blockchain:           "ARC-TESTNET",
    contractAddress:      AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: "submit(uint256,bytes32,bytes)",
    abiParameters:        [jobId.toString(), deliverableHash, "0x"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!submitTx.data?.id) throw new Error("submit tx failed to submit");
  await pollTx(submitTx.data.id, "submit deliverable");

  // 6. Complete job (client)
  const reasonHash = keccak256(toHex("deliverable-approved"));
  const completeTx = await circleClient.createContractExecutionTransaction({
    walletAddress:        CLIENT_WALLET.address,
    blockchain:           "ARC-TESTNET",
    contractAddress:      AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: "complete(uint256,bytes32,bytes)",
    abiParameters:        [jobId.toString(), reasonHash, "0x"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!completeTx.data?.id) throw new Error("complete tx failed to submit");
  await pollTx(completeTx.data.id, "complete job");

  // 7. Read final state
  const job = await publicClient.readContract({
    address:      AGENTIC_COMMERCE_CONTRACT,
    abi:          agenticCommerceAbi,
    functionName: "getJob",
    args:         [jobId],
  });

  const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];
  console.log(`\n  ✅ ${jobLabel} complete`);
  console.log(`     Status: ${STATUS[Number(job.status)]}`);
  console.log(`     Budget: ${formatUnits(job.budget, 6)} USDC`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🚀 Arc Testnet — ERC-8183 Multi-Job Runner");
  console.log(`   Client:   ${CLIENT_WALLET.address}`);
  console.log(`   Provider: ${PROVIDER_WALLET.address}`);
  console.log(`   Jobs to run: ${JOBS.length}`);

  // Check client balance before starting
  const startBalance = await getUsdcBalance(CLIENT_WALLET.id);
  console.log(`\n   Client USDC balance: ${startBalance}`);

  const totalBudget = JOBS.reduce((sum, j) => sum + parseFloat(j.budget), 0);
  console.log(`   Total USDC needed:   ${totalBudget}`);

  if (parseFloat(startBalance) < totalBudget) {
    console.warn(`\n⚠️  Warning: balance may be insufficient. Top up at https://faucet.circle.com`);
    console.warn(`   Client address: ${CLIENT_WALLET.address}`);
    console.warn(`   Press Ctrl+C to cancel or wait 5s to continue anyway...`);
    await delay(5000);
  }

  // Run all jobs sequentially
  let completed = 0;
  for (let i = 0; i < JOBS.length; i++) {
    const job = JOBS[i];
    try {
      await runJob(i, job.description, job.budget, job.deliverable);
      completed++;
    } catch (err: any) {
      console.error(`\n❌ Job ${i + 1} failed: ${err.message}`);
      console.log("   Continuing to next job...");
    }
    // Small pause between jobs to avoid rate limiting
    if (i < JOBS.length - 1) await delay(3000);
  }

  // Final balances
  const clientEnd   = await getUsdcBalance(CLIENT_WALLET.id);
  const providerEnd = await getUsdcBalance(PROVIDER_WALLET.id);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`🎉 Multi-job run complete: ${completed}/${JOBS.length} jobs succeeded`);
  console.log(`   Client USDC:   ${clientEnd}`);
  console.log(`   Provider USDC: ${providerEnd}`);
  console.log(`${"═".repeat(60)}`);
}

main().catch((err) => {
  console.error("\n❌ Fatal error:", err.message);
  process.exit(1);
});