// test/club.test.js
// Local verification of every requirement before deploying to Sepolia.
// Usage: npx hardhat test

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ONE = 10n ** 18n;
const URI = "https://example.com/campus-memo.json";

async function deployFixture() {
  const [admin, alice, bob, carol] = await ethers.getSigners();

  const Cpt = await ethers.getContractFactory("ClubPointsToken");
  const cpt = await Cpt.deploy();
  await cpt.waitForDeployment();

  const Memo = await ethers.getContractFactory("CampusMemo");
  const memo = await Memo.deploy(await cpt.getAddress());
  await memo.waitForDeployment();

  // alice and bob become club members; the reward pool holds 100 CPT.
  await cpt.connect(admin).setMember(alice.address, true);
  await cpt.connect(admin).setMember(bob.address, true);
  await cpt.connect(admin).fundRewardPool(100n * ONE);

  return { cpt, memo, admin, alice, bob, carol };
}

describe("ClubPointsToken (CPT)", function () {
  it("mints the full 1000 CPT batch in a single deployment event", async function () {
    const [admin] = await ethers.getSigners();
    const Cpt = await ethers.getContractFactory("ClubPointsToken");
    const cpt = await Cpt.deploy();
    await cpt.waitForDeployment();
    // fresh deployment, untouched: one batch, one recipient
    expect(await cpt.totalSupply()).to.equal(1000n * ONE);
    expect(await cpt.balanceOf(admin.address)).to.equal(1000n * ONE);
    expect(await cpt.rewardPool()).to.equal(0n);
  });

  it("mints exactly 1000 CPT in one batch to the deployer at deployment", async function () {
    const { cpt, admin } = await loadFixture(deployFixture);
    expect(await cpt.name()).to.equal("Club Points Token");
    expect(await cpt.symbol()).to.equal("CPT");
    expect(await cpt.decimals()).to.equal(18);
    // 1000 CPT exist in total; the fixture moved 100 of them into the reward pool.
    expect(await cpt.totalSupply()).to.equal(1000n * ONE);
    expect(await cpt.balanceOf(admin.address)).to.equal(900n * ONE);
    expect(await cpt.rewardPool()).to.equal(100n * ONE);
    expect(await cpt.balanceOf(admin.address) + (await cpt.rewardPool())).to.equal(1000n * ONE);
  });

  it("makes the deployer an administrator and a member", async function () {
    const { cpt, admin } = await loadFixture(deployFixture);
    expect(await cpt.isAdmin(admin.address)).to.equal(true);
    expect(await cpt.isMember(admin.address)).to.equal(true);
    expect(await cpt.owner()).to.equal(admin.address);
  });

  it("lets an administrator mint additional points", async function () {
    const { cpt, admin, alice } = await loadFixture(deployFixture);
    await expect(cpt.connect(admin).mint(alice.address, 250n * ONE))
      .to.emit(cpt, "PointsMinted")
      .withArgs(alice.address, 250n * ONE);
    expect(await cpt.balanceOf(alice.address)).to.equal(250n * ONE);
    expect(await cpt.totalSupply()).to.equal(1250n * ONE);
  });

  it("blocks non-administrators from minting (requirement 2)", async function () {
    const { cpt, alice } = await loadFixture(deployFixture);
    await expect(
      cpt.connect(alice).mint(alice.address, 1n * ONE)
    ).to.be.revertedWith("CPT: caller is not an administrator");
  });

  it("lets an administrator batch-distribute points", async function () {
    const { cpt, admin, alice, bob } = await loadFixture(deployFixture);
    await cpt.connect(admin).distribute(
      [alice.address, bob.address],
      [10n * ONE, 20n * ONE]
    );
    expect(await cpt.balanceOf(alice.address)).to.equal(10n * ONE);
    expect(await cpt.balanceOf(bob.address)).to.equal(20n * ONE);
  });

  it("rejects a batch distribution with mismatched array lengths", async function () {
    const { cpt, admin, alice, bob } = await loadFixture(deployFixture);
    await expect(
      cpt.connect(admin).distribute([alice.address, bob.address], [1n * ONE])
    ).to.be.revertedWith("CPT: length mismatch");
  });

  it("lets only the owner manage administrators", async function () {
    const { cpt, admin, alice, bob } = await loadFixture(deployFixture);
    await cpt.connect(admin).setAdmin(alice.address, true);
    expect(await cpt.isAdmin(alice.address)).to.equal(true);

    await expect(
      cpt.connect(bob).setAdmin(bob.address, true)
    ).to.be.revertedWithCustomError(cpt, "OwnableUnauthorizedAccount");
  });

  describe("Custom function #1 - dailyCheckIn()", function () {
    it("pays the check-in reward out of the reward pool, without minting", async function () {
      const { cpt, admin, alice } = await loadFixture(deployFixture);
      const supplyBefore = await cpt.totalSupply();

      await expect(cpt.connect(alice).dailyCheckIn())
        .to.emit(cpt, "CheckedIn");

      expect(await cpt.balanceOf(alice.address)).to.equal(10n * ONE);
      expect(await cpt.rewardPool()).to.equal(90n * ONE);
      // total supply is unchanged: no new CPT was created
      expect(await cpt.totalSupply()).to.equal(supplyBefore);
      expect(await cpt.balanceOf(admin.address)).to.equal(900n * ONE);
    });

    it("enforces the 24-hour cooldown", async function () {
      const { cpt, alice } = await loadFixture(deployFixture);
      await cpt.connect(alice).dailyCheckIn();
      await expect(cpt.connect(alice).dailyCheckIn()).to.be.revertedWith(
        "CPT: already checked in today"
      );
    });

    it("allows a new check-in after 24 hours", async function () {
      const { cpt, alice } = await loadFixture(deployFixture);
      await cpt.connect(alice).dailyCheckIn();
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await cpt.connect(alice).dailyCheckIn();
      expect(await cpt.balanceOf(alice.address)).to.equal(20n * ONE);
    });

    it("reports the remaining cooldown through secondsUntilNextCheckIn", async function () {
      const { cpt, alice } = await loadFixture(deployFixture);
      expect(await cpt.secondsUntilNextCheckIn(alice.address)).to.equal(0);
      await cpt.connect(alice).dailyCheckIn();
      const left = await cpt.secondsUntilNextCheckIn(alice.address);
      expect(left).to.be.greaterThan(23 * 60 * 60);
      expect(left).to.be.lessThanOrEqual(24 * 60 * 60);
    });

    it("rejects check-ins from non-members", async function () {
      const { cpt, carol } = await loadFixture(deployFixture);
      await expect(cpt.connect(carol).dailyCheckIn()).to.be.revertedWith(
        "CPT: caller is not a registered club member"
      );
    });

    it("reverts when the reward pool is empty", async function () {
      const { cpt, admin, alice } = await loadFixture(deployFixture);
      // drain the whole 100 CPT pool with a single 100 CPT check-in
      await cpt.connect(admin).setCheckInReward(100);
      await cpt.connect(alice).dailyCheckIn();
      expect(await cpt.rewardPool()).to.equal(0n);

      // next day the member qualifies for a check-in, but the pool is empty
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(cpt.connect(alice).dailyCheckIn()).to.be.revertedWith(
        "CPT: reward pool is empty"
      );
    });

    it("lets an administrator update the check-in reward", async function () {
      const { cpt, admin, alice } = await loadFixture(deployFixture);
      await expect(cpt.connect(admin).setCheckInReward(25))
        .to.emit(cpt, "CheckInRewardUpdated")
        .withArgs(10, 25);
      await cpt.connect(alice).dailyCheckIn();
      expect(await cpt.balanceOf(alice.address)).to.equal(25n * ONE);
    });

    it("keeps the reward pool in sync when CPT is sent directly to the contract", async function () {
      const { cpt, admin } = await loadFixture(deployFixture);
      await cpt.connect(admin).transfer(await cpt.getAddress(), 40n * ONE);
      expect(await cpt.rewardPool()).to.equal(140n * ONE);
    });

    it("lets only administrators fund the reward pool", async function () {
      const { cpt, alice } = await loadFixture(deployFixture);
      await expect(
        cpt.connect(alice).fundRewardPool(1n * ONE)
      ).to.be.revertedWith("CPT: caller is not an administrator");
    });
  });

  describe("Custom function #2 - redeemPoints()", function () {
    it("burns the member's own CPT and reduces totalSupply", async function () {
      const { cpt, alice } = await loadFixture(deployFixture);
      await cpt.connect(alice).dailyCheckIn(); // alice holds 10 CPT
      const supplyBefore = await cpt.totalSupply();

      await expect(cpt.connect(alice).redeemPoints(4n * ONE))
        .to.emit(cpt, "RedemptionRequested")
        .withArgs(alice.address, 4n * ONE);

      expect(await cpt.balanceOf(alice.address)).to.equal(6n * ONE);
      expect(await cpt.totalSupply()).to.equal(supplyBefore - 4n * ONE);
      expect(await cpt.redeemedPoints(alice.address)).to.equal(4n * ONE);
    });

    it("rejects redemption with insufficient points", async function () {
      const { cpt, alice } = await loadFixture(deployFixture);
      await expect(
        cpt.connect(alice).redeemPoints(1n * ONE)
      ).to.be.revertedWith("CPT: insufficient points");
    });

    it("rejects redemption of zero and from non-members", async function () {
      const { cpt, alice, bob, carol } = await loadFixture(deployFixture);
      await expect(cpt.connect(alice).redeemPoints(0)).to.be.revertedWith(
        "CPT: amount must be greater than zero"
      );
      await cpt.connect(bob).dailyCheckIn();
      await expect(cpt.connect(carol).redeemPoints(1n * ONE)).to.be.revertedWith(
        "CPT: caller is not a registered club member"
      );
    });
  });
});

describe("CampusMemo (Club Commemorative NFT)", function () {
  it("has a maximum total supply of 10", async function () {
    const { memo } = await loadFixture(deployFixture);
    expect(await memo.MAX_SUPPLY()).to.equal(10);
    expect(await memo.remainingSupply()).to.equal(10);
    expect(await memo.totalSupply()).to.equal(0);
    expect(await memo.name()).to.equal("Campus Memo");
    expect(await memo.symbol()).to.equal("CAMPUS-MEMO");
  });

  it("consumes 100 CPT per mint (burned, not transferred)", async function () {
    const { cpt, memo, admin, alice } = await loadFixture(deployFixture);
    await cpt.connect(admin).mint(alice.address, 150n * ONE);
    // balance: 150 CPT; nothing has been approved yet
    await cpt.connect(alice).approve(await memo.getAddress(), 100n * ONE);

    const supplyBefore = await cpt.totalSupply();
    await expect(memo.connect(alice).mint(URI))
      .to.emit(memo, "CommemorativeMinted")
      .withArgs(alice.address, 0, 100n * ONE);

    expect(await cpt.balanceOf(alice.address)).to.equal(50n * ONE);
    expect(await cpt.totalSupply()).to.equal(supplyBefore - 100n * ONE);
    expect(await memo.ownerOf(0)).to.equal(alice.address);
    expect(await memo.tokenURI(0)).to.equal(URI);
    expect(await memo.totalSupply()).to.equal(1);
  });

  it("requires an ERC-20 allowance before minting", async function () {
    const { cpt, memo, admin, alice } = await loadFixture(deployFixture);
    await cpt.connect(admin).mint(alice.address, 150n * ONE);
    await expect(memo.connect(alice).mint(URI)).to.be.revertedWithCustomError(
      cpt,
      "ERC20InsufficientAllowance"
    );
  });

  it("rejects a mint when the caller does not hold 100 CPT", async function () {
    const { memo, carol } = await loadFixture(deployFixture);
    await expect(memo.connect(carol).mint(URI)).to.be.revertedWith(
      "CampusMemo: not enough CPT"
    );
  });

  it("stops minting after 10 NFTs (requirement: max supply 10)", async function () {
    const { cpt, memo, admin } = await loadFixture(deployFixture);
    // the admin spent 100 CPT funding the reward pool, so top the balance back
    // up to 1000 CPT: exactly enough to pay for all ten commemoratives.
    await cpt.connect(admin).mint(admin.address, 100n * ONE);
    await cpt.connect(admin).approve(await memo.getAddress(), 1000n * ONE);

    for (let i = 0; i < 10; i++) {
      await memo.connect(admin).mint(URI);
    }
    expect(await memo.totalSupply()).to.equal(10);
    expect(await memo.remainingSupply()).to.equal(0);
    expect(await cpt.balanceOf(admin.address)).to.equal(0n);

    await cpt.connect(admin).mint(admin.address, 100n * ONE);
    await cpt.connect(admin).approve(await memo.getAddress(), 100n * ONE);
    await expect(memo.connect(admin).mint(URI)).to.be.revertedWith(
      "CampusMemo: max supply of 10 reached"
    );
  });

  it("makes commemorative NFTs soulbound / non-transferable", async function () {
    const { cpt, memo, admin, alice, bob } = await loadFixture(deployFixture);
    await cpt.connect(admin).mint(alice.address, 150n * ONE);
    await cpt.connect(alice).approve(await memo.getAddress(), 100n * ONE);
    await memo.connect(alice).mint(URI);

    await memo.connect(alice).approve(bob.address, 0);
    await expect(
      memo.connect(bob).transferFrom(alice.address, bob.address, 0)
    ).to.be.revertedWith("CampusMemo: commemorative NFTs are non-transferable");

    await expect(
      memo
        .connect(alice)
        ["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 0)
    ).to.be.revertedWith("CampusMemo: commemorative NFTs are non-transferable");
  });

  it("lets only the club administrator use mintTo", async function () {
    const { cpt, memo, admin, alice, bob } = await loadFixture(deployFixture);
    await cpt.connect(admin).mint(alice.address, 150n * ONE);
    await cpt.connect(alice).approve(await memo.getAddress(), 100n * ONE);
    await cpt.connect(admin).approve(await memo.getAddress(), 100n * ONE);

    await expect(
      memo.connect(alice).mintTo(bob.address, URI)
    ).to.be.revertedWith("CampusMemo: caller is not the club administrator");

    const tx = await memo.connect(admin).mintTo(bob.address, URI);
    await tx.wait();
    expect(await memo.ownerOf(0)).to.equal(bob.address);
  });

  it("exposes the linked CPT token and the club administrator", async function () {
    const { cpt, memo, admin } = await loadFixture(deployFixture);
    expect(await memo.cpt()).to.equal(await cpt.getAddress());
    expect(await memo.clubAdmin()).to.equal(admin.address);
    expect(await memo.MINT_PRICE()).to.equal(100);
  });

  it("supports the ERC-721 interfaces", async function () {
    const { memo } = await loadFixture(deployFixture);
    expect(await memo.supportsInterface("0x80ac58cd")).to.equal(true); // ERC721
    expect(await memo.supportsInterface("0x5b5e139f")).to.equal(true); // metadata
  });
});
