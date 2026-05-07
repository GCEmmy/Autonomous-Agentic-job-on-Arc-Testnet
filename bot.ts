

import { setTimeout as delay } from "node:timers/promises";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import {
  createPublicClient,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { arcTestnet } from "viem/chains";

// ─── Wallet config ─────────────────────────────────────────────────────────

const PROVIDER_WALLET = {
  id:      "f3533ffb-2c88-5fba-bd2f-b0772db4dc54",
  address: "0x604d283252cc8d13832a52a1171afecea290a9f2" as Address,
};

// ─── Contract addresses ────────────────────────────────────────────────────

const AGENTIC_COMMERCE_CONTRACT =
  "0x0747EEf0706327138c69792bF28Cd525089e4583" as Address;

// ─── ABI ───────────────────────────────────────────────────────────────────

const agenticCommerceAbi = [
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
    type: "function", name: "submit", stateMutability: "nonpayable",
    inputs: [
      { name: "jobId",       type: "uint256" },
      { name: "deliverable", type: "bytes32" },
      { name: "optParams",   type: "bytes"   },
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

const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

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

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

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

async function getJobStatus(jobId: bigint): Promise<number> {
  const job = await publicClient.readContract({
    address:      AGENTIC_COMMERCE_CONTRACT,
    abi:          agenticCommerceAbi,
    functionName: "getJob",
    args:         [jobId],
  });
  return Number(job.status);
}

async function getJobBudget(jobId: bigint): Promise<bigint> {
  const job = await publicClient.readContract({
    address:      AGENTIC_COMMERCE_CONTRACT,
    abi:          agenticCommerceAbi,
    functionName: "getJob",
    args:         [jobId],
  });
  return job.budget;
}

// ─── Handle a single job ───────────────────────────────────────────────────

async function handleJob(jobId: bigint): Promise<void> {
  log(`📋 New job detected — ID: ${jobId}`);

  let budget: bigint;
  try {
    budget = await getJobBudget(jobId);
    if (budget === 0n) budget = BigInt(1_000_000);
  } catch {
    budget = BigInt(1_000_000);
  }

  // Set budget
  log(`   Setting budget...`);
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

  // Wait for funded
  log(`   Waiting for client to fund...`);
  let funded = false;
  for (let i = 0; i < 60; i++) {
    await delay(5000);
    const status = await getJobStatus(jobId);
    log(`   Status: ${STATUS[status] ?? status}`);
    if (status === 1) { funded = true; break; }
    if (status >= 3) { log(`   Job ended: ${STATUS[status]}`); return; }
  }
  if (!funded) { log(`   ⚠️  Job ${jobId} never funded — skipping`); return; }

  // Submit deliverable
  log(`   Submitting deliverable...`);
  const deliverableHash = keccak256(toHex(`auto-deliverable-job-${jobId}-${Date.now()}`));
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

  log(`✅ Job ${jobId} deliverable submitted — awaiting client completion`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

const seenJobs = new Set<string>();

async function main() {
  log("🤖 Provider bot started");
  log(`   Provider: ${PROVIDER_WALLET.address}`);
  log(`   Contract: ${AGENTIC_COMMERCE_CONTRACT}`);
  log(`   Press Ctrl+C to stop\n`);

  // Watch live only — no historical scan
  const unwatch = publicClient.watchContractEvent({
    address:   AGENTIC_COMMERCE_CONTRACT,
    abi:       agenticCommerceAbi,
    eventName: "JobCreated",
    args:      { provider: PROVIDER_WALLET.address },
    onLogs: (logs) => {
      for (const event of logs) {
        const jobId = event.args.jobId;
        if (jobId === undefined) continue;
        const key = jobId.toString();
        if (seenJobs.has(key)) continue;
        seenJobs.add(key);
        handleJob(jobId).catch((err) => {
          log(`❌ Job ${jobId} error: ${err.message}`);
        });
      }
    },
    onError: (err) => {
      log(`⚠️  Watcher error: ${err.message} — retrying in 10s`);
    },
  });

  log("👀 Watching for new jobs...\n");

  process.on("SIGINT", () => {
    log("🛑 Bot stopped");
    unwatch();
    process.exit(0);
  });

  setInterval(() => {
    log(`💓 Bot alive — ${seenJobs.size} jobs seen so far`);
  }, 60_000);
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});