// scripts/verify.js
// Read-only verification of the on-chain functional test.
//
// Why this exists: a shared public RPC endpoint can serve state reads from a
// replica that has not yet caught up with the block that just included our
// transaction, so reading a balance immediately after `tx.wait()` can return a
// stale value. Reading at an explicit block height removes that ambiguity: the
// "after" value is pinned to the exact block that contains the transaction.
//
// Usage: npx hardhat run scripts/verify.js --network sepolia

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const ONE = 10n ** 18n;
const fmt = (v) => ethers.formatEther(v);
const fmtNum = (v) => v.toString();

function loadResults() {
  const f = path.join(__dirname, "..", "demo-results.json");
  if (!fs.existsSync(f)) throw new Error("demo-results.json not found - run scripts/demo.js first.");
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

// `demo.js` records both the narrative step (no hash) and the transaction
// (with hash) under the same label, so always pick the entry that has a hash.
function hasHash(r) {
  return typeof r.txHash === "string" && r.txHash.startsWith("0x");
}

function matches(r, prefix) {
  return r.step === prefix || r.step.startsWith(prefix + "-");
}

function findByStep(rows, prefix) {
  return rows.find((r) => matches(r, prefix) && (hasHash(r) || r.expectedRevert !== undefined));
}

function findAllByStep(rows, prefix) {
  return rows.filter((r) => matches(r, prefix) && hasHash(r));
}

async function blockOf(hash) {
  const rc = await ethers.provider.getTransactionReceipt(hash);
  return rc.blockNumber;
}

async function main() {
  const { summary, results } = loadResults();
  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments.json"), "utf8")
  );

  const cpt = await ethers.getContractAt("ClubPointsToken", deployment.clubPointsToken);
  const memo = await ethers.getContractAt("CampusMemo", deployment.campusMemo);

  const AT = (n) => ({ blockTag: n });

  console.log("=".repeat(78));
  console.log("Block-pinned verification of the on-chain functional test");
  console.log("=".repeat(78));
  console.log(`CPT        : ${deployment.clubPointsToken}`);
  console.log(`CampusMemo : ${deployment.campusMemo}`);
  console.log(`Admin      : ${deployment.deployer}`);

  const lines = [];
  const alice = "0xB7B8489a40a298EA306c5B46135927D51853F30A";
  const bob = "0xa6995a2fd3545cfcefED76C149419548e7aA69FD";
  const carol = "0xac3A3eaF0C12F6Afc52E515B4416539E439b07d1";

  // ---- S3: funding the reward pool ---------------------------------------
  {
    const b = await blockOf(findByStep(results, "S3").txHash);
    const poolBefore = await cpt.rewardPool(AT(b - 1));
    const poolAfter = await cpt.rewardPool(AT(b));
    const supplyBefore = await cpt.totalSupply(AT(b - 1));
    const supplyAfter = await cpt.totalSupply(AT(b));
    console.log(`\nT3  fundRewardPool(100 CPT)  [block ${b}]`);
    console.log(`    rewardPool   : ${fmt(poolBefore)} -> ${fmt(poolAfter)} CPT`);
    console.log(`    totalSupply  : ${fmt(supplyBefore)} -> ${fmt(supplyAfter)} CPT  (unchanged: a transfer, not a mint)`);
    lines.push({
      id: "T3",
      action: "admin: fundRewardPool(100e18)",
      block: b,
      before: { rewardPool: fmt(poolBefore), cptTotalSupply: fmt(supplyBefore) },
      after: { rewardPool: fmt(poolAfter), cptTotalSupply: fmt(supplyAfter) },
      verdict: poolAfter === 100n * ONE && supplyBefore === supplyAfter ? "PASS" : "CHECK",
    });
  }

  // ---- S4: the check-in itself -------------------------------------------
  {
    const b = await blockOf(findByStep(results, "S4").txHash);
    const aliceBefore = await cpt.balanceOf(alice, AT(b - 1));
    const aliceAfter = await cpt.balanceOf(alice, AT(b));
    const poolBefore = await cpt.rewardPool(AT(b - 1));
    const poolAfter = await cpt.rewardPool(AT(b));
    const supplyBefore = await cpt.totalSupply(AT(b - 1));
    const supplyAfter = await cpt.totalSupply(AT(b));
    const lastCheckIn = await cpt.lastCheckIn(alice, AT(b));
    const cooldown = await cpt.secondsUntilNextCheckIn(alice, AT(b));
    console.log(`\nT4  Alice: dailyCheckIn()  [block ${b}]`);
    console.log(`    alice CPT    : ${fmt(aliceBefore)} -> ${fmt(aliceAfter)}   (+10)`);
    console.log(`    rewardPool   : ${fmt(poolBefore)} -> ${fmt(poolAfter)} CPT   (-10, paid from the pool)`);
    console.log(`    totalSupply  : ${fmt(supplyBefore)} -> ${fmt(supplyAfter)} CPT   (unchanged: no new CPT created)`);
    console.log(`    lastCheckIn  : ${lastCheckIn} (unix)`);
    console.log(`    cooldown left: ${cooldown}s`);
    const ok =
      aliceAfter - aliceBefore === 10n * ONE &&
      poolBefore - poolAfter === 10n * ONE &&
      supplyBefore === supplyAfter;
    lines.push({
      id: "T4",
      action: "member: dailyCheckIn()",
      block: b,
      before: { aliceCpt: fmt(aliceBefore), rewardPool: fmt(poolBefore), cptTotalSupply: fmt(supplyBefore) },
      after: { aliceCpt: fmt(aliceAfter), rewardPool: fmt(poolAfter), cptTotalSupply: fmt(supplyAfter) },
      cooldownSeconds: cooldown.toString(),
      verdict: ok ? "PASS" : "CHECK",
    });
  }

  // ---- S9: redemption burns ----------------------------------------------
  {
    const b = await blockOf(findByStep(results, "S9").txHash);
    const supplyBefore = await cpt.totalSupply(AT(b - 1));
    const supplyAfter = await cpt.totalSupply(AT(b));
    const aliceBefore = await cpt.balanceOf(alice, AT(b - 1));
    const aliceAfter = await cpt.balanceOf(alice, AT(b));
    console.log(`\nT9  Alice: redeemPoints(5 CPT)  [block ${b}]`);
    console.log(`    alice CPT    : ${fmt(aliceBefore)} -> ${fmt(aliceAfter)}   (-5)`);
    console.log(`    totalSupply  : ${fmt(supplyBefore)} -> ${fmt(supplyAfter)} CPT   (-5, burned)`);
    lines.push({
      id: "T9",
      action: "member: redeemPoints(5e18)",
      block: b,
      before: { aliceCpt: fmt(aliceBefore), cptTotalSupply: fmt(supplyBefore) },
      after: { aliceCpt: fmt(aliceAfter), cptTotalSupply: fmt(supplyAfter) },
      verdict: supplyBefore - supplyAfter === 5n * ONE ? "PASS" : "CHECK",
    });
  }

  // ---- S11: minting the commemorative NFT --------------------------------
  {
    const b = await blockOf(findByStep(results, "S11").txHash);
    const supplyBefore = await cpt.totalSupply(AT(b - 1));
    const supplyAfter = await cpt.totalSupply(AT(b));
    const aliceBefore = await cpt.balanceOf(alice, AT(b - 1));
    const aliceAfter = await cpt.balanceOf(alice, AT(b));
    const memoSupplyBefore = await memo.totalSupply(AT(b - 1));
    const memoSupplyAfter = await memo.totalSupply(AT(b));
    const owner0 = await memo.ownerOf(0, AT(b));
    const uri0 = await memo.tokenURI(0, AT(b));
    console.log(`\nT11 Alice: CampusMemo.mint(tokenURI)  [block ${b}]`);
    console.log(`    alice CPT      : ${fmt(aliceBefore)} -> ${fmt(aliceAfter)}   (-100, consumed)`);
    console.log(`    CPT totalSupply: ${fmt(supplyBefore)} -> ${fmt(supplyAfter)}   (-100, burned)`);
    console.log(`    NFT totalSupply: ${fmtNum(memoSupplyBefore)} -> ${fmtNum(memoSupplyAfter)}`);
    console.log(`    ownerOf(0)     : ${owner0}`);
    console.log(`    tokenURI(0)    : ${uri0}`);
    const ok =
      aliceBefore - aliceAfter === 100n * ONE &&
      supplyBefore - supplyAfter === 100n * ONE &&
      memoSupplyAfter === 1n &&
      owner0.toLowerCase() === alice.toLowerCase();
    lines.push({
      id: "T11",
      action: "member: CampusMemo.mint(uri)",
      block: b,
      before: { aliceCpt: fmt(aliceBefore), cptTotalSupply: fmt(supplyBefore), nftTotalSupply: fmtNum(memoSupplyBefore) },
      after: { aliceCpt: fmt(aliceAfter), cptTotalSupply: fmt(supplyAfter), nftTotalSupply: fmtNum(memoSupplyAfter) },
      ownerOf0: owner0,
      tokenURI0: uri0,
      verdict: ok ? "PASS" : "CHECK",
    });
  }

  // ---- S14: minting up to the cap ----------------------------------------
  {
    const last = findAllByStep(results, "S14").filter((r) => r.txHash);
    const b = await blockOf(last[last.length - 1].txHash);
    const supply = await memo.totalSupply(AT(b));
    const remaining = await memo.remainingSupply(AT(b));
    console.log(`\nT14 admin: mints the remaining nine commemoratives  [last block ${b}]`);
    console.log(`    NFT totalSupply: ${supply}   remaining: ${remaining}`);
    lines.push({
      id: "T14",
      action: "admin: 9 x CampusMemo.mint(uri)",
      block: b,
      after: { nftTotalSupply: supply.toString(), nftRemaining: remaining.toString() },
      verdict: supply === 10n && remaining === 0n ? "PASS" : "CHECK",
    });
  }

  // ---- S15: the 11th mint is rejected ------------------------------------
  {
    const minted = findByStep(results, "S15a");
    const approved = findByStep(results, "S15b");
    const b = await blockOf(minted.txHash);
    const adminCpt = await cpt.balanceOf(deployment.deployer, AT(b));
    const revert = findByStep(results, "S15c");
    console.log(`\nT15 admin: 11th commemorative mint  [block ${b}]`);
    console.log(`    admin topped up to: ${fmt(adminCpt)} CPT`);
    console.log(`    mint() reverted with: ${revert ? revert.actualRevert : "(see demo log)"}`);
    lines.push({
      id: "T15",
      action: "admin: 11th CampusMemo.mint(uri)",
      block: b,
      revertedWith: revert ? revert.actualRevert : null,
      verdict: revert && /max supply/.test(revert.actualRevert || "") ? "PASS" : "CHECK",
    });
  }

  // ---- final state --------------------------------------------------------
  {
    const bn = await ethers.provider.getBlockNumber();
    const final = {
      cptTotalSupply: fmt(await cpt.totalSupply()),
      rewardPool: fmt(await cpt.rewardPool()),
      nftTotalSupply: (await memo.totalSupply()).toString(),
      nftRemaining: (await memo.remainingSupply()).toString(),
      adminCpt: fmt(await cpt.balanceOf(deployment.deployer)),
      aliceCpt: fmt(await cpt.balanceOf(alice)),
      bobCpt: fmt(await cpt.balanceOf(bob)),
      carolCpt: fmt(await cpt.balanceOf(carol)),
      aliceRedeemed: fmt(await cpt.redeemedPoints(alice)),
      aliceNft: (await memo.balanceOf(alice)).toString(),
      adminNft: (await memo.balanceOf(deployment.deployer)).toString(),
    };
    console.log(`\nFINAL on-chain state  [block ${bn}]`);
    console.log(JSON.stringify(final, null, 2));
    lines.push({ id: "FINAL", action: "read all state", block: bn, values: final });
  }

  // ---- negative / access-control cases (reverts, no state change) ---------
  const negatives = ["S5", "S8", "S12", "S13b", "S15c"].map((s) => {
    const r = findByStep(results, s);
    return r ? { step: s, expected: r.expectedRevert, actual: r.actualRevert, matched: r.matched } : null;
  }).filter(Boolean);

  console.log("\nNEGATIVE / ACCESS-CONTROL CASES (reverted, no state change)");
  for (const n of negatives) {
    console.log(`  ${n.step.padEnd(6)} ${n.matched ? "PASS" : "CHECK"}  ${n.actual}`);
  }

  const out = {
    verifiedAt: new Date().toISOString(),
    clubPointsToken: deployment.clubPointsToken,
    campusMemo: deployment.campusMemo,
    deployer: deployment.deployer,
    checkpoints: lines,
    negativeCases: negatives,
  };
  fs.writeFileSync(path.join(__dirname, "..", "verification.json"), JSON.stringify(out, null, 2));
  console.log(`\nSaved block-pinned verification to verification.json`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
