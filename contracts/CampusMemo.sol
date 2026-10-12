// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "./ClubPointsToken.sol";

/**
 * @title CampusMemo (Club Commemorative NFT)
 * @notice Limited-edition commemorative NFT of a drone club (ERC-721).
 *
 * Implements the core requirements:
 *  1. Maximum total supply = 10.
 *  2. Minting 1 commemorative NFT consumes 100 CPT.
 *
 * The token is also non-transferable. A commemorative item should stay with
 * the member who earned it, so transfers between two non-zero addresses are
 * rejected while minting and burning stay possible.
 */
contract CampusMemo is ERC721, ERC721URIStorage {
    /// @notice Maximum number of commemorative NFTs that can ever exist.
    uint256 public constant MAX_SUPPLY = 10;

    /// @notice Price of one commemorative NFT, expressed in whole CPT.
    uint256 public constant MINT_PRICE = 100;

    /// @notice The club points token used to pay for the NFT.
    ClubPointsToken public immutable cpt;

    /// @notice Club administrator allowed to use the administrative mint path.
    address public immutable clubAdmin;

    uint256 private _nextTokenId;

    event CommemorativeMinted(address indexed to, uint256 indexed tokenId, uint256 cptBurned);

    modifier onlyAdmin() {
        require(msg.sender == clubAdmin, "CampusMemo: caller is not the club administrator");
        _;
    }

    constructor(address cptAddress) ERC721("Campus Memo", "CAMPUS-MEMO") {
        require(cptAddress != address(0), "CampusMemo: invalid CPT address");
        cpt = ClubPointsToken(cptAddress);
        clubAdmin = msg.sender;
    }

    // ---------------------------------------------------------------------
    // Minting: 100 CPT consumed per NFT, 10 NFTs in total
    // ---------------------------------------------------------------------

    /**
     * @notice Mints one commemorative NFT to the caller and burns 100 CPT.
     * @dev The caller must first approve this contract for at least 100 CPT.
     * @param uri Metadata URI of the commemorative NFT.
     * @return tokenId The id of the freshly minted NFT.
     */
    function mint(string calldata uri) external returns (uint256) {
        return _mintCommemorative(msg.sender, uri);
    }

    /**
     * @notice Mints one commemorative NFT to another address (club use, e.g.
     *         rewarding a member who does not manage a wallet herself).
     * @dev Still paid for by the caller's CPT; administrators only.
     */
    function mintTo(address to, string calldata uri) external onlyAdmin returns (uint256) {
        return _mintCommemorative(to, uri);
    }

    function _mintCommemorative(address to, string calldata uri) private returns (uint256) {
        require(to != address(0), "CampusMemo: zero address");
        require(_nextTokenId < MAX_SUPPLY, "CampusMemo: max supply of 10 reached");

        uint256 cost = MINT_PRICE * 10 ** cpt.decimals();
        require(cpt.balanceOf(msg.sender) >= cost, "CampusMemo: not enough CPT");

        // Pay for the commemorative: 100 CPT are burned, i.e. consumed forever.
        cpt.burnFrom(msg.sender, cost);

        uint256 tokenId = _nextTokenId;
        _nextTokenId = tokenId + 1;

        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);

        emit CommemorativeMinted(to, tokenId, cost);
        return tokenId;
    }

    /// @notice Number of commemorative NFTs minted so far.
    function totalSupply() external view returns (uint256) {
        return _nextTokenId;
    }

    /// @notice Remaining commemorative NFTs available to mint.
    function remainingSupply() external view returns (uint256) {
        return MAX_SUPPLY - _nextTokenId;
    }

    // ---------------------------------------------------------------------
    // Soulbound behaviour
    // ---------------------------------------------------------------------

    /**
     * @dev Blocks transfers between two existing owners (from != 0, to != 0)
     *      while still allowing minting (from == 0) and burning (to == 0).
     */
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            revert("CampusMemo: commemorative NFTs are non-transferable");
        }
        return super._update(to, tokenId, auth);
    }

    // ---------------------------------------------------------------------
    // Required ERC-721 overrides
    // ---------------------------------------------------------------------

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
