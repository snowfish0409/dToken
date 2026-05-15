// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title dToken Fixed Supply ERC20
/// @notice Minimal fixed-supply ERC20 used by the dToken protocol. The token has no mint path after deployment.
contract DTokenFixed {
    string public constant name = "dToken";
    string public constant symbol = "DTOKEN";
    uint8 public constant decimals = 18;
    uint256 public constant DTOKEN_UNIT = 1e18;
    uint256 public constant INITIAL_SUPPLY = 10_000_000_000_000_000 * DTOKEN_UNIT;

    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error ZeroAddress();
    error InvalidAmount();

    constructor(address initialSupplyRecipient) {
        if (initialSupplyRecipient == address(0)) revert ZeroAddress();
        totalSupply = INITIAL_SUPPLY;
        balanceOf[initialSupplyRecipient] = INITIAL_SUPPLY;
        emit Transfer(address(0), initialSupplyRecipient, INITIAL_SUPPLY);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InvalidAmount();
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < amount) revert InvalidAmount();
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
