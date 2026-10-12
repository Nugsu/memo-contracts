// scripts/demo.js
// Runs the complete functional test scenario against the deployed contracts and
// prints every transaction hash / Etherscan link so the run can be verified.
//
// Usage: npx hardhat run scripts/demo.js --network sepolia

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const NFT_URI =
  process.env.NFT_URI ||
  "https://gist.githubusercontent.com/Nugsu/40b698a04166106f2223c2d13ddec1af/raw/campus-memo.json";

const results = [];

function record(step, action, detail) {
  const line = { step, action, detail };
  results.push(line);
  console.log(`\n[${step}] ${action}`);
  if (detail) console.log(`    ${detail}`);
}

let lastBlock = 0;

/**
 * Wait until the RPC endpoint has moved past `blockNumber`.
 *
 * A shared public RPC can answer `eth_call` / `eth_getBalance` from a replica
 * that has not caught up with the block that just included our transaction, so
 * a read taken straight after `tx.wait()` can return the previous state.
 */
async function syncTo(blockNumber) {
  const target = Number(blockNumber);
  for (let i = 0; i < 60; i++) {
    const current = await ethers.provider.getBlockNumber();
    if (current > target) {
      lastBlock = current;
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function tx(label, promise, signer) {
  const t = await promise;
  const rc = await t.wait();
  await syncTo(rc.blockNumber);
  const from = signer ? await signer.getAddress() : "";
  const url = `https://sepolia.etherscan.io/tx/${rc.hash}`;
  console.log(`    tx: ${rc.hash}`);
  console.log(`    block: ${rc.blockNumber}  gas used: ${rc.gasUsed.toString()}  |  ${url}`);
  results.push({
    step: label,
    txHash: rc.hash,
    block: Number(rc.blockNumber),
    gasUsed: rc.gasUsed.toString(),
    url,
  });
  return rc;
}

async function expectRevert(label, promise, expectedFragment) {
  try {
    const t = await promise;
    await t.wait();
    console.log(`    !! UNEXPECTED SUCCESS for ${label}`);
    results.push({ step: label, expectedRevert: expectedFragment, actual: "NO REVERT (unexpected)" });
  } catch (err) {
    const msg = (err.shortMessage || err.message || "").split("\n")[0];
    const ok = !expectedFragment || msg.includes(expectedFragment);
    console.log(`    reverted as expected: ${msg}`);
    results.push({
      step: label,
      expectedRevert: expectedFragment,
      actualRevert: msg,
      matched: ok,
    });
  }
}

async function main() {
  const deploymentFile = path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(deploymentFile)) {
    throw new Error("deployments.json not found - run scripts/deploy.js first.");
  }
  const record_ = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));

  const [admin] = await ethers.getSigners();
  const cpt = await ethers.getContractAt("ClubPointsToken", record_.clubPointsToken, admin);
  const memo = await ethers.getContractAt("CampusMemo", record_.campusMemo, admin);

  const alice = ethers.Wallet.createRandom().connect(ethers.provider);
  const bob = ethers.Wallet.createRandom().connect(ethers.provider);
  const carol = ethers.Wallet.createRandom().connect(ethers.provider);

  console.log("=".repeat(70));
  console.log("Club loyalty system - on-chain functional test");
  console.log("=".repeat(70));
  console.log(`Admin   : ${admin.address}`);
  console.log(`Alice   : ${alice.address}`);
  console.log(`Bob     : ${bob.address}`);
  console.log(`Carol   : ${carol.address}`);
  console.log(`CPT     : ${record_.clubPointsToken}`);
  console.log(`CampusMemo: ${record_.campusMemo}`);

  const ONE = 10n ** 18n;
  const fmt = (v) => ethers.formatEther(v);

  // Fund the two test wallets with a little Sepolia ETH for gas.
  record("S0", "Fund test wallets with gas ETH", "0.004 ETH each");
  await tx("S0a", admin.sendTransaction({ to: alice.address, value: ethers.parseEther("0.004") }), admin);
  await tx("S0b", admin.sendTransaction({ to: bob.address, value: ethers.parseEther("0.004") }), admin);
  await tx("S0c", admin.sendTransaction({ to: carol.address, value: ethers.parseEther("0.004") }), admin);

  record("S1", "Rule 1 - initial batch of 1000 CPT minted at deployment", "");
  console.log(`    totalSupply(CPT) = ${fmt(await cpt.totalSupply())}`);
  console.log(`    admin CPT balance = ${fmt(await cpt.balanceOf(admin.address))}`);

  record("S2", "Admin registers Alice as a club member");
  await tx("S2", cpt.connect(admin).setMember(alice.address, true), admin);
  console.log(`    isMember(alice) = ${await cpt.isMember(alice.address)}`);

  record("S3", "Custom #1 - Admin funds the check-in reward pool with 100 CPT");
  await tx("S3", cpt.connect(admin).fundRewardPool(100n * ONE), admin);
  console.log(`    rewardPool = ${fmt(await cpt.rewardPool())} CPT`);

  record("S4", "Custom #1 - Alice performs dailyCheckIn() and earns 10 CPT");
  const before = await cpt.balanceOf(alice.address);
  await tx("S4", cpt.connect(alice).dailyCheckIn(), alice);
  const after = await cpt.balanceOf(alice.address);
  console.log(`    alice CPT: ${fmt(before)} -> ${fmt(after)}  (reward pool now ${fmt(await cpt.rewardPool())})`);

  record("S5", "Negative test - a second check-in within 24h must revert");
  await expectRevert("S5", cpt.connect(alice).dailyCheckIn(), "already checked in today");
  console.log(`    secondsUntilNextCheckIn(alice) = ${await cpt.secondsUntilNextCheckIn(alice.address)}`);

  record("S6", "Rule 2 - Admin mints 300 CPT to Bob");
  await tx("S6", cpt.connect(admin).mint(bob.address, 300n * ONE), admin);

  record("S7", "Rule 2 - Admin batch-distributes 150 CPT to Alice and 150 to Bob");
  await tx("S7", cpt.connect(admin).distribute([alice.address, bob.address], [150n * ONE, 150n * ONE]), admin);

  record("S8", "Rule 2 - Negative test: Bob (non-admin) tries to mint and must revert");
  await expectRevert("S8", cpt.connect(bob).mint(bob.address, 1000n * ONE), "not an administrator");

  record("S9", "Custom #2 - Alice voluntarily burns 5 CPT to request club withdrawal");
  const supplyBefore = await cpt.totalSupply();
  await tx("S9", cpt.connect(alice).redeemPoints(5n * ONE), alice);
  const supplyAfter = await cpt.totalSupply();
  console.log(`    CPT totalSupply: ${fmt(supplyBefore)} -> ${fmt(supplyAfter)} (burned 5)`);
  console.log(`    redeemedPoints(alice) = ${fmt(await cpt.redeemedPoints(alice.address))}`);

  record("S10", "NFT - Alice approves the CampusMemo contract to spend 100 CPT");
  await tx("S10", cpt.connect(alice).approve(record_.campusMemo, 100n * ONE), alice);
  console.log(`    allowance(alice -> CampusMemo) = ${fmt(await cpt.allowance(alice.address, record_.campusMemo))}`);

  record("S11", "NFT - Alice mints commemorative NFT #0 for 100 CPT");
  const aliceBefore = await cpt.balanceOf(alice.address);
  const supplyBefore2 = await cpt.totalSupply();
  await tx("S11", memo.connect(alice).mint(NFT_URI), alice);
  const aliceAfter = await cpt.balanceOf(alice.address);
  console.log(`    alice CPT: ${fmt(aliceBefore)} -> ${fmt(aliceAfter)} (-100, consumed/burned)`);
  console.log(`    CPT totalSupply: ${fmt(supplyBefore2)} -> ${fmt(await cpt.totalSupply())} (-100)`);
  console.log(`    memo.totalSupply = ${await memo.totalSupply()}  remaining = ${await memo.remainingSupply()}`);
  console.log(`    ownerOf(0) = ${await memo.ownerOf(0)}`);
  console.log(`    tokenURI(0) = ${await memo.tokenURI(0)}`);

  record("S12", "NFT - Negative test: minting without enough CPT must revert");
  console.log(`    carol CPT balance = ${fmt(await cpt.balanceOf(carol.address))}`);
  await expectRevert("S12", memo.connect(carol).mint(NFT_URI), "not enough CPT");

  record("S13", "NFT - Negative test: commemorative NFT is soulbound (transfer must revert)");
  console.log(`    alice approving bob for token 0 ...`);
  await tx("S13a", memo.connect(alice).approve(bob.address, 0), alice);
  await expectRevert(
    "S13b",
    memo.connect(bob).transferFrom(alice.address, bob.address, 0),
    "non-transferable"
  );

  record("S14", "NFT - Admin mints the remaining 9 commemorative NFTs (total supply reaches 10)");
  const adminBal = await cpt.balanceOf(admin.address);
  console.log(`    admin CPT balance before top-up = ${fmt(adminBal)}`);
  // The admin needs 900 CPT to pay for the remaining nine commemoratives.
  const topUp = 900n * ONE - adminBal;
  if (topUp > 0n) {
    console.log(`    admin mints ${fmt(topUp)} extra CPT (administrator mint path)`);
    await tx("S14-topup", cpt.connect(admin).mint(admin.address, topUp), admin);
  }
  console.log(`    admin CPT balance = ${fmt(await cpt.balanceOf(admin.address))}`);
  await tx("S14a", cpt.connect(admin).approve(record_.campusMemo, 9n * 100n * ONE), admin);
  for (let i = 0; i < 9; i++) {
    await tx(`S14-mint-${i + 2}`, memo.connect(admin).mint(NFT_URI), admin);
  }
  console.log(`    memo.totalSupply = ${await memo.totalSupply()}  remaining = ${await memo.remainingSupply()}`);

  record("S15", "NFT - Negative test: the 11th mint must revert (max supply = 10)");
  await tx("S15a", cpt.connect(admin).mint(admin.address, 100n * ONE), admin);
  await tx("S15b", cpt.connect(admin).approve(record_.campusMemo, 100n * ONE), admin);
  await expectRevert("S15c", memo.connect(admin).mint(NFT_URI), "max supply");

  record("S16", "Final on-chain state");
  const summary = {
    network: record_.network,
    clubPointsToken: record_.clubPointsToken,
    campusMemo: record_.campusMemo,
    tokenURIofToken0: await memo.tokenURI(0),
    cptTotalSupply: fmt(await cpt.totalSupply()),
    rewardPool: fmt(await cpt.rewardPool()),
    memoTotalSupply: (await memo.totalSupply()).toString(),
    memoRemaining: (await memo.remainingSupply()).toString(),
    adminCptBalance: fmt(await cpt.balanceOf(admin.address)),
    aliceCptBalance: fmt(await cpt.balanceOf(alice.address)),
    bobCptBalance: fmt(await cpt.balanceOf(bob.address)),
    aliceRedeemed: fmt(await cpt.redeemedPoints(alice.address)),
    aliceNftBalance: (await memo.balanceOf(alice.address)).toString(),
    adminNftBalance: (await memo.balanceOf(admin.address)).toString(),
    checkedAt: new Date().toISOString(),
  };
  console.log(JSON.stringify(summary, null, 2));

  const outFile = path.join(__dirname, "..", "demo-results.json");
  fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2));
  console.log(`\nSaved demo transcript to ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
