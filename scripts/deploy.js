// scripts/deploy.js
// Deploys ClubPointsToken (CPT) then CampusMemo (Campus-Memo NFT) to the
// selected network and writes the resulting addresses to deployments.json.
//
// Usage: npx hardhat run scripts/deploy.js --network sepolia

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = hre.network.name;

  console.log("=".repeat(64));
  console.log(`Network      : ${net}`);
  console.log(`Deployer/Admin: ${deployer.address}`);
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Balance      : ${hre.ethers.formatEther(bal)} ETH`);
  console.log("=".repeat(64));

  // 1) Club Points Token: 1000 CPT minted in one batch to the deployer
  const Cpt = await hre.ethers.getContractFactory("ClubPointsToken");
  const cpt = await Cpt.deploy();
  await cpt.waitForDeployment();
  const cptAddress = await cpt.getAddress();
  console.log(`\n[1/2] ClubPointsToken (CPT) deployed at: ${cptAddress}`);
  console.log(`      name   : ${await cpt.name()}`);
  console.log(`      symbol : ${await cpt.symbol()}`);
  console.log(`      totalSupply: ${hre.ethers.formatEther(await cpt.totalSupply())} CPT`);
  console.log(`      deployer balance: ${hre.ethers.formatEther(await cpt.balanceOf(deployer.address))} CPT`);

  // 2) Campus-Memo NFT: max supply 10, 100 CPT per mint
  const Memo = await hre.ethers.getContractFactory("CampusMemo");
  const memo = await Memo.deploy(cptAddress);
  await memo.waitForDeployment();
  const memoAddress = await memo.getAddress();
  console.log(`\n[2/2] CampusMemo (Campus-Memo) deployed at: ${memoAddress}`);
  console.log(`      name   : ${await memo.name()}`);
  console.log(`      symbol : ${await memo.symbol()}`);
  console.log(`      MAX_SUPPLY  : ${await memo.MAX_SUPPLY()}`);
  console.log(`      MINT_PRICE  : ${await memo.MINT_PRICE()} CPT`);
  console.log(`      linked CPT  : ${await memo.cpt()}`);

  const record = {
    network: net,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    clubPointsToken: cptAddress,
    campusMemo: memoAddress,
    tokenName: await cpt.name(),
    tokenSymbol: await cpt.symbol(),
    nftName: await memo.name(),
    nftSymbol: await memo.symbol(),
    deployedAt: new Date().toISOString(),
    explorer: {
      cpt: `https://sepolia.etherscan.io/address/${cptAddress}`,
      campusMemo: `https://sepolia.etherscan.io/address/${memoAddress}`,
    },
  };

  const outFile = path.join(__dirname, "..", "deployments.json");
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log(`\nSaved deployment record to ${outFile}`);

  console.log("\n--- Deployed addresses ---");
  console.log(`Club Token (CPT) address        : ${cptAddress}`);
  console.log(`Commemorative NFT address       : ${memoAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
