# Club Points Token & Campus Memo

An on-chain loyalty system for a drone club, deployed to the Sepolia testnet
(chain ID 11155111): club points that members earn, and a limited-edition
commemorative they redeem those points for.

| Contract | Standard | File | What it does |
| --- | --- | --- | --- |
| ClubPointsToken (`CPT`) | ERC-20 | `contracts/ClubPointsToken.sol` | Club points. 1000 CPT are minted in one batch at deployment; only club administrators may mint or distribute more. |
| CampusMemo (`CAMPUS-MEMO`) | ERC-721 | `contracts/CampusMemo.sol` | Commemorative NFT. Maximum total supply 10, and minting one consumes 100 CPT. |

On top of the two core requirements I added two functions and made one design
change:

1. `dailyCheckIn()`: a registered member checks in once a day and is paid CPT out of
   a reward pool the administrator funds in advance. Check-in never mints, so the
   "administrators are the only minters" rule still holds.
2. `redeemPoints()`: a member voluntarily burns their own CPT to apply for club
   withdrawal.
3. CampusMemo is non-transferable, so a commemorative stays with the member who
   earned it.

## Deployed addresses (Sepolia)

| | |
| --- | --- |
| ClubPointsToken (CPT) | `0xC5A870AB5E317c82Ed962cCB1A95b7DAce4782DC` |
| CampusMemo | `0xa173e4E730DD46DED5a31964D4D5Dd6aCE9c89F9` |
| Deployer / club administrator | `0xCaD22D98a961Afc8A1350eAe841a08729F55FcCa` |

NFT `tokenURI`:
`https://gist.githubusercontent.com/Nugsu/40b698a04166106f2223c2d13ddec1af/raw/campus-memo.json`

## Files

```
.
├── contracts/
│   ├── ClubPointsToken.sol        ERC-20 club points + the two extra functions
│   └── CampusMemo.sol             ERC-721 commemorative (max 10, 100 CPT per mint)
├── test/club.test.js              local tests for every requirement
├── scripts/
│   ├── deploy.js                  deploys both contracts, writes deployments.json
│   ├── demo.js                    runs the functional test on-chain, prints every tx
│   └── verify.js                  re-reads the state at each tx's block height
├── metadata/campus-memo.json      the ERC-721 metadata served by tokenURI
├── metadata/campus-memo.svg       the artwork (SVG, so a gist serves it as an image)
├── deployments.json               the deployed addresses
├── demo-results.json              every transaction hash from the on-chain run
├── verification.json              state before/after each step, with a verdict
├── hardhat.config.js
├── package.json
└── .env.example
```

## Build and test locally

```bash
npm install
npx hardhat compile
npx hardhat test
```

`npx hardhat test` covers all of the following:

- 1000 CPT are minted in one batch at deployment, and the symbol is `CPT`.
- a non-administrator cannot call `mint()`, `distribute()` or `fundRewardPool()`.
- `dailyCheckIn()` pays out of the reward pool, enforces the 24 hour cooldown,
  rejects non-members and reverts when the pool is empty.
- `redeemPoints()` burns the caller's own CPT and lowers `totalSupply()`.
- one mint costs exactly 100 CPT, and those CPT are burned rather than transferred.
- the 10th NFT can be minted and the 11th reverts with `max supply of 10 reached`.
- the commemorative NFT cannot be transferred.

## Deploy to Sepolia

```bash
cp .env.example .env      # then put your own PRIVATE_KEY in it
npx hardhat run scripts/deploy.js --network sepolia
npx hardhat run scripts/demo.js --network sepolia
```

`deploy.js` prints the two addresses and writes them to `deployments.json`.
`demo.js` then drives the whole scenario against those contracts and prints a
transaction hash and an Etherscan link for every step.

### Deploying from Remix instead

`npm run flatten` writes `remix/CampusMemo_flat.sol`, a `hardhat flatten` output. It
contains OpenZeppelin 5.0.2, `ClubPointsToken` and `CampusMemo` in a single file with
no `import` statements, so pasting it into Remix needs nothing from npm. Compile with
solc 0.8.28; both contracts then appear in the Deploy list, so deploy
`ClubPointsToken` with no arguments first and `CampusMemo` afterwards passing the CPT
address.

## Notes on the implementation

- The reward pool exists because only administrators may mint points. If
  `dailyCheckIn()` called `_mint`, the contract itself would create CPT and
  break that rule, so the administrator funds a pool with `fundRewardPool()` and
  a check-in only transfers CPT out of it. The `_update` hook keeps `rewardPool`
  in step with the CPT the contract actually holds.
- A mint consumes 100 CPT, so the minter's CPT is burned through `burnFrom()`.
  The caller therefore has to `approve()` the CampusMemo contract for 100 CPT
  before minting.
- `CampusMemo._update` reverts when both `from` and `to` are non-zero. That blocks
  transfers between holders while leaving minting (`from == 0`) and burning
  (`to == 0`) working, so the token is still a normal ERC-721 in every other way.
