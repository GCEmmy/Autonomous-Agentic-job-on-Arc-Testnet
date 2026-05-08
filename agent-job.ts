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

// ─── Wallets ───────────────────────────────────────────────────────────────

const ERC8004_OWNER = {
  id:      "04c16dac-bf4e-5051-9e35-99ca5f32e4d8",
  address: "0xe345393164a245576ad831f5571a1e72a91bfa50" as Address,
};

const ERC8004_VALIDATOR = {
  id:      "6709266a-3b5c-51db-805a-8879c1e12505",
  address: "0x84d20b13ee833ad069e63468da5da7eccf6bf7f7" as Address,
};

const ERC8183_CLIENT = {
  id:      "fef51e10-d568-5c18-b146-9d53a44c1ae7",
  address: "0xc7c43433c8b13d6fc7a0d96574d05526ce34db18" as Address,
};

const ERC8183_PROVIDER = {
  id:      "f3533ffb-2c88-5fba-bd2f-b0772db4dc54",
  address: "0x604d283252cc8d13832a52a1171afecea290a9f2" as Address,
};

// ─── Config ────────────────────────────────────────────────────────────────

const AGENT_ID        = 3110n;
const JOB_BUDGET_USDC = "3";
const JOB_DESCRIPTION = "Agentic settlement monitoring: validate USDC escrow flows on Arc Testnet";

// ─── Contracts ─────────────────────────────────────────────────────────────

const IDENTITY_REGISTRY   = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address;
const AGENTIC_COMMERCE    = "0x0747EEf0706327138c69792bF28Cd525089e4583" as Address;
const USDC_CONTRACT       = "0x3600000000000000000000000000000000000000" as Address;

// ─── ABIs ──────────────────────────────────────────────────────────────────

const identityAbi = [
  {
    type: "function", name: "ownerOf", stateMutability: "view",
    inputs:  [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "",        type: "address" }],
  },
] as const;

const reputationAbi = [
  {
    type: "function", name: "giveFeedback", stateMutability: "nonpayable",
    inputs: [
      { name: "agentId",      type: "uint256" },
      { name: "score",        type: "int128"  },
      { name: "feedbackType", type: "uint8"   },
      { name: "tag",          type: "string"  },
      { name: "context",      type: "string"  },
      { name: "reference",    type: "string"  },
      { name: "metadata",     type: "string"  },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

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

async function pollTx(id: string, label: string): Promise<Hex> {
  process.stdout.write(`  ⏳ ${label}`);
  for (let i = 0; i < 60; i++) {
    await delay(2000);
    const { data } = await circleClient.getTransaction({ id });
    const tx = data?.transaction;
    if (tx?.state === "COMPLETE") {
      if (!tx.txHash) throw new Error(`${label} completed but txHash missing`);
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

// Score based on job outcome:
// Completed clean  → 95
// Completed late   → 70
// Never delivered  → 20
function calculateScore(status: number): number {
  if (status === 3) return 95; // Completed
  if (status === 4) return 20; // Rejected
  return 50;                   // Anything else
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const budget = parseUnits(JOB_BUDGET_USDC, 6);

  console.log("\n🤖 ERC-8004 + ERC-8183 Connected Agent Flow");
  console.log(`   Agent ID:  ${AGENT_ID}`);
  console.log(`   Client:    ${ERC8183_CLIENT.address}`);
  console.log(`   Provider:  ${ERC8183_PROVIDER.address}`);
  console.log(`   Budget:    ${JOB_BUDGET_USDC} USDC\n`);

  // ── Step 1: Verify agent identity ──────────────────────────────────────
  console.log("── Step 1: Verify agent identity ──");

  const agentOwner = await publicClient.readContract({
    address:      IDENTITY_REGISTRY,
    abi:          identityAbi,
    functionName: "ownerOf",
    args:         [AGENT_ID],
  });

  if (agentOwner.toLowerCase() !== ERC8004_OWNER.address.toLowerCase()) {
    throw new Error(`Agent ${AGENT_ID} owner mismatch — expected ${ERC8004_OWNER.address}, got ${agentOwner}`);
  }
  console.log(`  ✅ Agent ${AGENT_ID} identity verified — owner: ${agentOwner}\n`);

  // ── Step 2: Create job ──────────────────────────────────────────────────
  console.log("── Step 2: Create job ──");

  const now       = await publicClient.getBlock();
  const expiredAt = now.timestamp + 3600n;

  const createTx = await circleClient.createContractExecutionTransaction({
    walletAddress:        ERC8183_CLIENT.address,
    blockchain:           "ARC-TESTNET",
    contractAddress:      AGENTIC_COMMERCE,
    abiFunctionSignature: "createJob(address,address,uint256,string,address)",
    abiParameters: [
      ERC8183_PROVIDER.address,
      ERC8183_CLIENT.address,
      expiredAt.toString(),
      JOB_DESCRIPTION,
      "0x0000000000000000000000000000000000000000",
    ],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!createTx.data?.id) throw new Error("createJob tx failed to submit");
  const createHash = await pollTx(createTx.data.id, "createJob");
  const jobId      = await extractJobId(createHash);
  console.log(`  Job ID: ${jobId}\n`);

  // ── Step 3: Provider sets budget ────────────────────────────────────────
  console.log("── Step 3: Set budget ──");

  const setBudgetTx = await circleClient.createContractExecutionTransaction({
    walletAddress:        ERC8183_PROVIDER.address,
    blockchain:           "ARC-TESTNET",
    contractAddress:      AGENTIC_COMMERCE,
    abiFunctionSignature: "setBudget(uint256,uint256,bytes)",
    abiParameters:        [jobId.toString(), budget.toString(), "0x"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!setBudgetTx.data?.id) throw new Error("setBudget tx failed to submit");
  await pollTx(setBudgetTx.data.id, "setBudget");
  console.log();

  // ── Step 4: Approve and fund escrow ────────────────────────────────────
  console.log("── Step 4: Approve and fund escrow ──");

  const approveTx = await circleClient.createContractExecutionTransaction({
    walletAddress:        ERC8183_CLIENT.address,
    blockchain:           "ARC-TESTNET",
    contractAddress:      USDC_CONTRACT,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters:        [AGENTIC_COMMERCE, budget.toString()],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!approveTx.data?.id) throw new Error("approve tx failed to submit");
  await pollTx(approveTx.data.id, "approve USDC");

  const fundTx = await circleClient.createContractExecutionTransaction({
    walletAddress:        ERC8183_CLIENT.address,
    blockchain:           "ARC-TESTNET",
    contractAddress:      AGENTIC_COMMERCE,
    abiFunctionSignature: "fund(uint256,bytes)",
    abiParameters:        [jobId.toString(), "0x"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!fundTx.data?.id) throw new Error("fund tx failed to submit");
  await pollTx(fundTx.data.id, "fund escrow");
  console.log();

  // ── Step 5: Submit deliverable ──────────────────────────────────────────
  console.log("── Step 5: Submit deliverable ──");

  const deliverableHash = keccak256(toHex(`agent-${AGENT_ID}-job-${jobId}-${Date.now()}`));

  const submitTx = await circleClient.createContractExecutionTransaction({
    walletAddress:        ERC8183_PROVIDER.address,
    blockchain:           "ARC-TESTNET",
    contractAddress:      AGENTIC_COMMERCE,
    abiFunctionSignature: "submit(uint256,bytes32,bytes)",
    abiParameters:        [jobId.toString(), deliverableHash, "0x"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!submitTx.data?.id) throw new Error("submit tx failed to submit");
  await pollTx(submitTx.data.id, "submit deliverable");
  console.log();

  // ── Step 6: Complete job ────────────────────────────────────────────────
  console.log("── Step 6: Complete job ──");

  const completeTx = await circleClient.createContractExecutionTransaction({
    walletAddress:        ERC8183_CLIENT.address,
    blockchain:           "ARC-TESTNET",
    contractAddress:      AGENTIC_COMMERCE,
    abiFunctionSignature: "complete(uint256,bytes32,bytes)",
    abiParameters:        [jobId.toString(), keccak256(toHex("deliverable-approved")), "0x"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!completeTx.data?.id) throw new Error("complete tx failed to submit");
  await pollTx(completeTx.data.id, "complete job");
  console.log();

  // ── Step 7: Read final job state ────────────────────────────────────────
  const finalJob = await publicClient.readContract({
    address:      AGENTIC_COMMERCE,
    abi:          agenticCommerceAbi,
    functionName: "getJob",
    args:         [jobId],
  });

  const jobStatus = Number(finalJob.status);
  const score     = calculateScore(jobStatus);

  // ── Step 8: Record reputation based on job outcome ──────────────────────
  console.log("── Step 7: Record reputation ──");
  console.log(`  Job status: ${STATUS[jobStatus]} → score: ${score}`);

  const tag          = `job_${jobId}_${STATUS[jobStatus].toLowerCase()}`;
  const feedbackHash = keccak256(toHex(tag));

  const repTx = await circleClient.createContractExecutionTransaction({
    walletAddress:        ERC8004_VALIDATOR.address,
    blockchain:           "ARC-TESTNET",
    contractAddress:      REPUTATION_REGISTRY,
    abiFunctionSignature: "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
    abiParameters:        [AGENT_ID.toString(), score.toString(), "0", tag, JOB_DESCRIPTION, "", "", feedbackHash],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  if (!repTx.data?.id) throw new Error("giveFeedback tx failed to submit");
  await pollTx(repTx.data.id, "record reputation");
  console.log();

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`${"═".repeat(60)}`);
  console.log(`🎉 Done!`);
  console.log(`   Agent ID:       ${AGENT_ID}`);
  console.log(`   Job ID:         ${jobId}`);
  console.log(`   Status:         ${STATUS[jobStatus]}`);
  console.log(`   Budget:         ${formatUnits(finalJob.budget, 6)} USDC`);
  console.log(`   Reputation tag: ${tag}`);
  console.log(`   Score recorded: ${score}`);
  console.log(`${"═".repeat(60)}\n`);
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});