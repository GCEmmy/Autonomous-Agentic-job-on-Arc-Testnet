import { setTimeout as delay } from "node:timers/promises";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import {
  createPublicClient,
  decodeEventLog,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { arcTestnet } from "viem/chains";

// ─── Wallet config ─────────────────────────────────────────────────────────

const CLIENT_WALLET = {
  id:      "fef51e10-d568-5c18-b146-9d53a44c1ae7",
  address: "0xc7c43433c8b13d6fc7a0d96574d05526ce34db18" as Address,
};

const PROVIDER_WALLET_ADDRESS =
  "0x604d283252cc8d13832a52a1171afecea290a9f2" as Address;

// ─── Contract addresses ────────────────────────────────────────────────────

const AGENTIC_COMMERCE_CONTRACT =
  "0x0747EEf0706327138c69792bF28Cd525089e4583" as Address;

const USDC_CONTRACT =
  "0x3600000000000000000000000000000000000000" as Address;

// ─── Job to create ─────────────────────────────────────────────────────────
// Edit description and budget as needed

const JOB_DESCRIPTION = "Autonomous liquidity monitoring: track USDC pool depth on Arc Testnet every 10 minutes";
const JOB_BUDGET_USDC = "20";

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
    type: "function", name: "fund", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",     type: "uint256" },
      { name: "optParams", type: "bytes"   },
    ],
    outputs: [],
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
  chain:     arcTestnet,
  transport: http(),
});

// ─── Helpers ───────────────────────────────────────────────────────────────

async function pollTx(id: string, label: string): Promise<Hex> {
  process.stdout.write(`  ⏳ ${label}`);
  for (let i = 0; i < 60; i++) {
    await delay(2000);
    const { data } = await circleClient.getTransaction({ id });
    const tx = data?.transaction;
    if (tx?.state === "COMPLETE") {
      if (!tx.txHash) throw new Error(`${label} completed but txHash is missing`);
      console.log(` ✅  https://testnet.arcscan.app/tx/${tx.txHash}`);
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

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const budget = parseUnits(JOB_BUDGET_USDC, 6);

  console.log("\n🛠  Creating job for bot to handle...");
  console.log(`   Client:   ${CLIENT_WALLET.address}`);
  console.log(`   Provider: ${PROVIDER_WALLET_ADDRESS}`);
  console.log(`   Budget:   ${JOB_BUDGET_USDC} USDC`);
  console.log(`   Job:      ${JOB_DESCRIPTION}\n`);

  // 1. Create job
  const now       = await publicClient.getBlock();
  const expiredAt = now.timestamp + 3600n;

  const createTx = await circleClient.createContractExecutionTransaction({
    walletAddress:        CLIENT_WALLET.address,
    blockchain:           "ARC-TESTNET",
    contractAddress:      AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: "createJob(address,address,uint256,string,address)",
    abiParameters: [
      PROVIDER_WALLET_ADDRESS,
      CLIENT_WALLET.address,
      expiredAt.toString(),
      JOB_DESCRIPTION,
      "0x0000000000000000000000000000000000000000",
    ],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!createTx.data?.id) throw new Error("createJob tx failed to submit");
  const createHash = await pollTx(createTx.data.id, "createJob");
  const jobId      = await extractJobId(createHash);
  console.log(`\n  Job ID: ${jobId}`);

  // 2. Approve USDC
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

  // 3. Fund escrow
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

  console.log(`\n✅ Job ${jobId} created and funded`);
  console.log(`   The bot should now detect this job and handle setBudget + submit automatically`);
  console.log(`   Watch your bot terminal!\n`);
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});