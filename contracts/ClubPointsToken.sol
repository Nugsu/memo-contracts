// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ClubPointsToken (CPT)
 * @notice Club points for a drone club (ERC-20).
 *
 * Implements the two core requirements:
 *  1. 1000 CPT are minted in a single batch at deployment.
 *  2. Only club administrators may mint or distribute additional points.
 *
 * On top of that there is a small member registry and two extra functions,
 * `dailyCheckIn()` and `redeemPoints()`, which turn the token into a working
 * loyalty programme rather than a static balance.
 */
contract ClubPointsToken is ERC20, ERC20Burnable, Ownable {
    /// @notice Initial batch of club points minted at deployment (whole tokens).
    uint256 public constant INITIAL_SUPPLY = 1000;

    /// @notice Points awarded for one successful daily check-in (whole tokens).
    uint256 public checkInReward = 10;

    /// @notice Minimum interval between two check-ins of the same member.
    uint256 public constant CHECK_IN_INTERVAL = 1 days;

    /// @notice Club administrators. The owner is an administrator as well.
    mapping(address => bool) public isAdmin;

    /// @notice Club members (managed by an administrator).
    mapping(address => bool) public isMember;

    /// @notice Timestamp of the last successful check-in of a member.
    mapping(address => uint256) public lastCheckIn;

    /// @notice Accumulated points burned by each member through redemption.
    mapping(address => uint256) public redeemedPoints;

    /// @notice CPT held by the contract itself: the check-in reward pool.
    /// @dev Kept in sync automatically by the `_update` hook below, so CPT sent
    ///      to the contract address by any means is accounted for.
    uint256 public rewardPool;

    event AdminUpdated(address indexed account, bool status);
    event MemberUpdated(address indexed account, bool status);
    event PointsMinted(address indexed to, uint256 amount);
    event PointsDistributed(address indexed to, uint256 amount);
    event RewardPoolFunded(address indexed from, uint256 amount);
    event CheckedIn(address indexed member, uint256 reward, uint256 timestamp);
    event RedemptionRequested(address indexed member, uint256 amount);
    event CheckInRewardUpdated(uint256 oldReward, uint256 newReward);

    modifier onlyAdmin() {
        require(isAdmin[msg.sender] || msg.sender == owner(), "CPT: caller is not an administrator");
        _;
    }

    modifier onlyMember() {
        require(isMember[msg.sender], "CPT: caller is not a registered club member");
        _;
    }

    /**
     * @dev Mints the whole 1000 CPT batch to the deployer, who becomes the
     *      club administrator (owner) and the first registered member.
     */
    constructor() ERC20("Club Points Token", "CPT") Ownable(msg.sender) {
        isAdmin[msg.sender] = true;
        isMember[msg.sender] = true;
        _mint(msg.sender, INITIAL_SUPPLY * 10 ** decimals());

        emit AdminUpdated(msg.sender, true);
        emit MemberUpdated(msg.sender, true);
        emit PointsMinted(msg.sender, INITIAL_SUPPLY * 10 ** decimals());
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /// @notice Grants or revokes club administrator rights. Owner only.
    function setAdmin(address account, bool status) external onlyOwner {
        require(account != address(0), "CPT: zero address");
        isAdmin[account] = status;
        emit AdminUpdated(account, status);
    }

    /// @notice Registers or removes a club member. Administrators only.
    function setMember(address account, bool status) external onlyAdmin {
        require(account != address(0), "CPT: zero address");
        isMember[account] = status;
        emit MemberUpdated(account, status);
    }

    /// @notice Adjusts the reward paid for a successful check-in. Administrators only.
    function setCheckInReward(uint256 newReward) external onlyAdmin {
        emit CheckInRewardUpdated(checkInReward, newReward);
        checkInReward = newReward;
    }

    // ---------------------------------------------------------------------
    // Rule 2: only administrators mint / distribute points
    // ---------------------------------------------------------------------

    /// @notice Mints additional club points. Administrators only.
    function mint(address to, uint256 amount) external onlyAdmin {
        require(to != address(0), "CPT: zero address");
        _mint(to, amount);
        emit PointsMinted(to, amount);
    }

    /// @notice Distributes points to several members in a single transaction.
    function distribute(address[] calldata recipients, uint256[] calldata amounts) external onlyAdmin {
        require(recipients.length == amounts.length, "CPT: length mismatch");
        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "CPT: zero address");
            _mint(recipients[i], amounts[i]);
            emit PointsDistributed(recipients[i], amounts[i]);
        }
    }

    // ---------------------------------------------------------------------
    // Custom function 1: daily check-in
    // ---------------------------------------------------------------------

    /**
     * @notice Funds the check-in reward pool. Administrators only.
     * @dev The administrator moves CPT from their own balance into the contract.
     *      Because check-ins are paid out of this pool, no new CPT is created
     *      outside of the administrator-approved mint path.
     */
    function fundRewardPool(uint256 amount) external onlyAdmin {
        require(balanceOf(msg.sender) >= amount, "CPT: insufficient balance to fund pool");
        _transfer(msg.sender, address(this), amount);
        emit RewardPoolFunded(msg.sender, amount);
    }

    /**
     * @notice Custom function 1. A member checks in once every 24 hours and
     *         receives `checkInReward` CPT from the reward pool.
     * @dev Enforces (a) membership, (b) a 24h cooldown, (c) pool solvency.
     *      Does not mint; it transfers from the pool, so the "administrators
     *      are the only minters" rule is preserved.
     */
    function dailyCheckIn() external onlyMember {
        uint256 last = lastCheckIn[msg.sender];
        if (last != 0) {
            require(block.timestamp >= last + CHECK_IN_INTERVAL, "CPT: already checked in today");
        }
        uint256 reward = checkInReward * 10 ** decimals();
        require(rewardPool >= reward, "CPT: reward pool is empty");

        lastCheckIn[msg.sender] = block.timestamp;
        _transfer(address(this), msg.sender, reward);

        emit CheckedIn(msg.sender, reward, block.timestamp);
    }

    /// @notice Seconds left before the caller may check in again (0 = ready).
    function secondsUntilNextCheckIn(address member) external view returns (uint256) {
        uint256 last = lastCheckIn[member];
        if (last == 0) return 0;
        uint256 readyAt = last + CHECK_IN_INTERVAL;
        if (block.timestamp >= readyAt) return 0;
        return readyAt - block.timestamp;
    }

    // ---------------------------------------------------------------------
    // Custom function 2: voluntary redemption (burn) / club withdrawal
    // ---------------------------------------------------------------------

    /**
     * @notice Custom function 2. A member voluntarily burns their own CPT to
     *         apply for a club withdrawal / redemption.
     * @dev Burning permanently removes the points from circulation (reducing
     *      totalSupply) and records the redeemed amount for off-chain handling
     *      by the club committee.
     */
    function redeemPoints(uint256 amount) external onlyMember {
        require(amount > 0, "CPT: amount must be greater than zero");
        require(balanceOf(msg.sender) >= amount, "CPT: insufficient points");

        redeemedPoints[msg.sender] += amount;
        _burn(msg.sender, amount);

        emit RedemptionRequested(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Internal bookkeeping
    // ---------------------------------------------------------------------

    /**
     * @dev Keeps `rewardPool` in sync with the CPT actually held by the
     *      contract, regardless of who sent it.
     */
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to == address(this)) {
            rewardPool += value;
        } else if (from == address(this)) {
            rewardPool -= value;
        }
    }
}
