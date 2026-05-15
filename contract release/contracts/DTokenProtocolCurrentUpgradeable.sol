// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title dToken Protocol V0 Upgradeable
/// @notice Clean current protocol contract for LLM provider discovery, dToken escrow, user-signed
///         cumulative settlement proofs, challenge-period exits, and settlement.
/// @dev The ERC20 token is intentionally separate and fixed-supply. This contract only holds escrowed dToken.
contract DTokenProtocolV0Upgradeable {
    string public constant name = "dToken";
    string public constant SIGNING_VERSION = "0";
    string public constant PROTOCOL_VERSION = "0";

    bytes32 public constant USER_DTOKEN_SETTLEMENT_TYPEHASH = keccak256(
        "UserDTokenSettlement(bytes32 handshakeId,uint256 cumulativeSpent,bytes32 meteringHash,uint64 signedAt)"
    );
    bytes32 public constant HANDSHAKE_CREDENTIAL_DOMAIN = keccak256("dtoken-handshake-v0");
    uint64 public constant FIXED_CHALLENGE_PERIOD_SECONDS = 10 minutes;

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint256 private constant _SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    address private immutable __self = address(this);

    enum HandshakeStatus {
        None,
        Open,
        UserBreakupPending,
        Settled
    }

    struct ProviderUpdate {
        string metadataURI;
        bytes32 metadataHash;
    }

    struct Handshake {
        HandshakeStatus status;
        address userWallet;
        address providerOperator;
        address userSessionSigner;
        bytes32 handshakeCredentialHash;
        uint256 escrowAmount;
        uint256 pendingCloseAmount;
        uint64 challengeDeadline;
        bytes32 pendingSettlementProofHash;
        bytes32 providerOfferId;
    }

    struct UserDTokenSettlement {
        bytes32 handshakeId;
        uint256 cumulativeSpent;
        bytes32 meteringHash;
        uint64 signedAt;
    }

    uint8 private _initialized;
    bool private _initializing;

    address public upgradeAdmin;
    address public pendingUpgradeAdmin;
    uint64 private _legacyChallengePeriodSeconds;
    uint64 public maxSettlementFutureDriftSeconds;

    IERC20 public dToken;
    uint256 public escrowedSupply;

    mapping(bytes32 => Handshake) private _handshakes;

    uint256[48] private __gap;

    event Initialized(uint8 version, address indexed admin, address indexed token);
    event UpgradeAdminTransferStarted(address indexed previousAdmin, address indexed pendingAdmin);
    event UpgradeAdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event Upgraded(address indexed implementation);
    event MaxSettlementFutureDriftUpdated(uint64 previousDrift, uint64 newDrift);

    event ProviderAnnounced(
        address indexed provider,
        bytes32 indexed offerId,
        bytes32 indexed metadataHash,
        string metadataURI,
        uint64 version
    );

    event HandshakeOpened(
        bytes32 indexed handshakeId,
        address indexed userWallet,
        address indexed provider,
        address userSessionSigner,
        bytes32 handshakeCredentialHash,
        bytes32 offerId,
        bytes32 metadataHash,
        uint256 escrowAmount
    );
    event HandshakeOpenedForOffer(
        bytes32 indexed handshakeId,
        bytes32 indexed offerId,
        bytes32 indexed metadataHash
    );

    event UserBreakupRequested(
        bytes32 indexed handshakeId,
        uint256 pendingCloseAmount,
        bytes32 indexed settlementProofHash,
        uint64 challengeDeadline
    );
    event UserBreakupChallenged(
        bytes32 indexed handshakeId,
        uint256 pendingCloseAmount,
        bytes32 indexed settlementHash
    );
    event HandshakeSettled(
        bytes32 indexed handshakeId,
        uint256 providerAmount,
        uint256 userRefund,
        bytes32 settlementProofHash
    );
    error AlreadyInitialized();
    error NotInitializing();
    error InvalidImplementation();
    error UpgradeCallFailed();
    error TokenTransferFailed();
    error ZeroAddress();
    error InvalidAmount();
    error Unauthorized();
    error HandshakeNotFound();
    error HandshakeNotOpen();
    error InvalidStatus();
    error InvalidSignature();
    error BudgetExceeded();
    error NonMonotonicSpend();
    error InvalidMeteringHash();
    error SettlementFromFuture();
    error ChallengeStillActive();
    error ChallengeExpired();

    modifier initializer() {
        if (_initialized != 0) revert AlreadyInitialized();
        _initialized = 1;
        _initializing = true;
        _;
        _initializing = false;
    }

    modifier onlyUpgradeAdmin() {
        if (msg.sender != upgradeAdmin) revert Unauthorized();
        _;
    }

    modifier onlyProxy() {
        if (address(this) == __self || _getImplementation() != __self) revert InvalidImplementation();
        _;
    }

    modifier notDelegated() {
        if (address(this) != __self) revert InvalidImplementation();
        _;
    }

    constructor() {
        _initialized = type(uint8).max;
    }

    function initialize(address initialAdmin, address tokenAddress)
        external
        initializer
    {
        if (initialAdmin == address(0) || tokenAddress == address(0)) revert ZeroAddress();
        if (tokenAddress.code.length == 0) revert ZeroAddress();
        upgradeAdmin = initialAdmin;
        dToken = IERC20(tokenAddress);
        maxSettlementFutureDriftSeconds = 5 minutes;
        emit Initialized(0, initialAdmin, tokenAddress);
    }

    function proxiableUUID() external view notDelegated returns (bytes32) {
        return _IMPLEMENTATION_SLOT;
    }

    function upgradeTo(address newImplementation) external onlyProxy onlyUpgradeAdmin {
        _upgradeToAndCall(newImplementation, "");
    }

    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable onlyProxy onlyUpgradeAdmin {
        _upgradeToAndCall(newImplementation, data);
    }

    function transferUpgradeAdmin(address newAdmin) external onlyUpgradeAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingUpgradeAdmin = newAdmin;
        emit UpgradeAdminTransferStarted(upgradeAdmin, newAdmin);
    }

    function acceptUpgradeAdmin() external {
        if (msg.sender != pendingUpgradeAdmin) revert Unauthorized();
        address previous = upgradeAdmin;
        upgradeAdmin = pendingUpgradeAdmin;
        pendingUpgradeAdmin = address(0);
        emit UpgradeAdminTransferred(previous, upgradeAdmin);
    }

    function setMaxSettlementFutureDrift(uint64 newDrift) external onlyUpgradeAdmin {
        if (newDrift > 1 hours) revert InvalidAmount();
        uint64 previous = maxSettlementFutureDriftSeconds;
        maxSettlementFutureDriftSeconds = newDrift;
        emit MaxSettlementFutureDriftUpdated(previous, newDrift);
    }

    function challengePeriod() external pure returns (uint64) {
        return FIXED_CHALLENGE_PERIOD_SECONDS;
    }

    function challengePeriodSeconds() external pure returns (uint64) {
        return FIXED_CHALLENGE_PERIOD_SECONDS;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes(SIGNING_VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    function handshakeCredentialHashFor(bytes32 handshakeCredential) public view returns (bytes32) {
        if (handshakeCredential == bytes32(0)) revert InvalidAmount();
        return keccak256(abi.encode(HANDSHAKE_CREDENTIAL_DOMAIN, block.chainid, address(this), handshakeCredential));
    }

    function announceProvider(ProviderUpdate calldata update) external {
        _validateProviderUpdate(update);
        bytes32 offerId = offerIdFor(msg.sender, update.metadataHash);
        _emitProviderAnnouncement(msg.sender, offerId, update.metadataHash, update.metadataURI, uint64(block.number));
    }

    function _validateProviderUpdate(ProviderUpdate calldata update) internal pure {
        if (bytes(update.metadataURI).length == 0 || update.metadataHash == bytes32(0)) revert InvalidAmount();
    }

    function _emitProviderAnnouncement(
        address providerOperator,
        bytes32 offerId,
        bytes32 metadataHash,
        string memory metadataURI,
        uint64 version
    ) internal {
        emit ProviderAnnounced(
            providerOperator,
            offerId,
            metadataHash,
            metadataURI,
            version
        );
    }

    function openHandshakeWithProvider(
        address providerOperator,
        ProviderUpdate calldata provider,
        address userSessionSigner,
        bytes32 handshakeCredentialHash,
        uint256 escrowAmount
    ) external returns (bytes32 handshakeId) {
        bytes32 offerId = offerIdFor(providerOperator, provider.metadataHash);
        return _openHandshake(
            provider,
            offerId,
            providerOperator,
            userSessionSigner,
            handshakeCredentialHash,
            escrowAmount
        );
    }

    function _openHandshake(
        ProviderUpdate calldata provider,
        bytes32 offerId,
        address providerOperator,
        address userSessionSigner,
        bytes32 handshakeCredentialHash,
        uint256 escrowAmount
    ) internal returns (bytes32 handshakeId) {
        _validateProviderUpdate(provider);
        if (userSessionSigner == address(0) || providerOperator == address(0)) revert ZeroAddress();
        if (handshakeCredentialHash == bytes32(0)) revert InvalidAmount();
        if (escrowAmount == 0) revert InvalidAmount();

        handshakeId = keccak256(
            abi.encode(
                "DTOKEN_HANDSHAKE_V10",
                block.chainid,
                address(this),
                msg.sender,
                providerOperator,
                userSessionSigner,
                handshakeCredentialHash,
                escrowAmount,
                offerId,
                provider.metadataHash,
                keccak256(bytes(provider.metadataURI)),
                block.timestamp
            )
        );
        if (_handshakes[handshakeId].status != HandshakeStatus.None) revert InvalidStatus();

        _escrowFrom(msg.sender, escrowAmount);

        Handshake storage handshake = _handshakes[handshakeId];
        handshake.status = HandshakeStatus.Open;
        handshake.userWallet = msg.sender;
        handshake.providerOperator = providerOperator;
        handshake.providerOfferId = offerId;
        handshake.userSessionSigner = userSessionSigner;
        handshake.handshakeCredentialHash = handshakeCredentialHash;
        handshake.escrowAmount = escrowAmount;

        emit HandshakeOpened(
            handshakeId,
            msg.sender,
            providerOperator,
            userSessionSigner,
            handshakeCredentialHash,
            offerId,
            provider.metadataHash,
            escrowAmount
        );
        emit HandshakeOpenedForOffer(handshakeId, offerId, provider.metadataHash);
    }

    function providerSettleWithUserSettlement(
        UserDTokenSettlement calldata settlement,
        bytes calldata userSignature,
        ProviderUpdate calldata refreshUpdate
    ) external {
        Handshake storage handshake = _openHandshakeForProvider(settlement.handshakeId);
        bytes32 settlementHash = _verifyUserSettlement(handshake, settlement, userSignature);
        _settle(settlement.handshakeId, handshake, settlement.cumulativeSpent, settlementHash);
        _refreshProviderAnnouncementIfEarned(handshake, refreshUpdate, settlement.cumulativeSpent);
    }

    function providerClaimUserBreakup(bytes32 handshakeId, ProviderUpdate calldata refreshUpdate) external {
        Handshake storage handshake = _handshakes[handshakeId];
        if (handshake.status != HandshakeStatus.UserBreakupPending) revert InvalidStatus();
        _requireProviderActor(handshake);
        _settle(
            handshakeId,
            handshake,
            handshake.pendingCloseAmount,
            handshake.pendingSettlementProofHash
        );
        _refreshProviderAnnouncementIfEarned(handshake, refreshUpdate, handshake.pendingCloseAmount);
    }

    function requestUserBreakupWithUserSettlement(
        UserDTokenSettlement calldata settlement,
        bytes calldata userSignature
    ) external {
        Handshake storage handshake = _openHandshakeForId(settlement.handshakeId);
        if (msg.sender != handshake.userWallet) revert Unauthorized();
        bytes32 settlementHash = _verifyUserSettlement(handshake, settlement, userSignature);
        _startUserBreakup(
            settlement.handshakeId,
            handshake,
            settlementHash,
            settlement.cumulativeSpent
        );
    }

    function challengeUserBreakupWithUserSettlement(
        UserDTokenSettlement calldata settlement,
        bytes calldata userSignature,
        ProviderUpdate calldata refreshUpdate
    ) external {
        Handshake storage handshake = _handshakes[settlement.handshakeId];
        if (handshake.status != HandshakeStatus.UserBreakupPending) revert InvalidStatus();
        _requireProviderActor(handshake);
        if (block.timestamp >= handshake.challengeDeadline) revert ChallengeExpired();

        bytes32 settlementHash = _verifyUserSettlement(handshake, settlement, userSignature);
        if (settlement.cumulativeSpent <= handshake.pendingCloseAmount) revert NonMonotonicSpend();

        emit UserBreakupChallenged(settlement.handshakeId, settlement.cumulativeSpent, settlementHash);
        _settle(settlement.handshakeId, handshake, settlement.cumulativeSpent, settlementHash);
        _refreshProviderAnnouncementIfEarned(handshake, refreshUpdate, settlement.cumulativeSpent);
    }

    function finalizeUserBreakup(bytes32 handshakeId) external {
        Handshake storage handshake = _handshakes[handshakeId];
        if (handshake.status != HandshakeStatus.UserBreakupPending) revert InvalidStatus();
        if (msg.sender != handshake.userWallet && msg.sender != handshake.userSessionSigner) revert Unauthorized();
        if (block.timestamp < handshake.challengeDeadline) revert ChallengeStillActive();
        _settle(
            handshakeId,
            handshake,
            handshake.pendingCloseAmount,
            handshake.pendingSettlementProofHash
        );
    }

    function providerFinalizeUserBreakup(bytes32 handshakeId, ProviderUpdate calldata refreshUpdate) external {
        Handshake storage handshake = _handshakes[handshakeId];
        if (handshake.status != HandshakeStatus.UserBreakupPending) revert InvalidStatus();
        _requireProviderActor(handshake);
        if (block.timestamp < handshake.challengeDeadline) revert ChallengeStillActive();
        _settle(
            handshakeId,
            handshake,
            handshake.pendingCloseAmount,
            handshake.pendingSettlementProofHash
        );
        _refreshProviderAnnouncementIfEarned(handshake, refreshUpdate, handshake.pendingCloseAmount);
    }

    function offerIdFor(address providerOperator, bytes32 metadataHash) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(providerOperator, metadataHash));
    }

    function getHandshake(bytes32 handshakeId) external view returns (Handshake memory) {
        return _handshakes[handshakeId];
    }

    function userSettlementStructHash(UserDTokenSettlement calldata settlement) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                USER_DTOKEN_SETTLEMENT_TYPEHASH,
                settlement.handshakeId,
                settlement.cumulativeSpent,
                settlement.meteringHash,
                settlement.signedAt
            )
        );
    }

    function userSettlementDigest(UserDTokenSettlement calldata settlement) public view returns (bytes32) {
        return _hashTypedData(userSettlementStructHash(settlement));
    }

    function verifyUserSettlement(UserDTokenSettlement calldata settlement, bytes calldata signature)
        external
        view
        returns (bool)
    {
        Handshake storage handshake = _handshakes[settlement.handshakeId];
        if (handshake.status == HandshakeStatus.None) return false;
        address signer = _recover(userSettlementDigest(settlement), signature);
        return signer == handshake.userSessionSigner || signer == handshake.userWallet;
    }

    function _verifyUserSettlement(
        Handshake storage handshake,
        UserDTokenSettlement calldata settlement,
        bytes calldata userSignature
    ) internal view returns (bytes32 settlementHash) {
        settlementHash = userSettlementDigest(settlement);
        address signer = _recover(settlementHash, userSignature);
        if (signer != handshake.userSessionSigner && signer != handshake.userWallet) revert Unauthorized();
        _validateSettlementAgainstHandshake(handshake, settlement);
    }

    function _validateSettlementAgainstHandshake(
        Handshake storage handshake,
        UserDTokenSettlement calldata settlement
    ) internal view {
        if (settlement.handshakeId == bytes32(0)) revert HandshakeNotFound();
        if (settlement.meteringHash == bytes32(0)) revert InvalidMeteringHash();
        if (settlement.cumulativeSpent > handshake.escrowAmount) revert BudgetExceeded();
        if (settlement.signedAt > block.timestamp + maxSettlementFutureDriftSeconds) revert SettlementFromFuture();
    }

    function _startUserBreakup(
        bytes32 handshakeId,
        Handshake storage handshake,
        bytes32 settlementHash,
        uint256 pendingCloseAmount
    ) internal {
        if (pendingCloseAmount > handshake.escrowAmount) revert BudgetExceeded();
        handshake.status = HandshakeStatus.UserBreakupPending;
        handshake.pendingSettlementProofHash = settlementHash;
        handshake.pendingCloseAmount = pendingCloseAmount;
        handshake.challengeDeadline = uint64(block.timestamp) + FIXED_CHALLENGE_PERIOD_SECONDS;
        emit UserBreakupRequested(
            handshakeId,
            pendingCloseAmount,
            settlementHash,
            handshake.challengeDeadline
        );
    }

    function _settle(
        bytes32 handshakeId,
        Handshake storage handshake,
        uint256 providerAmount,
        bytes32 settlementProofHash
    ) internal {
        if (providerAmount > handshake.escrowAmount) revert BudgetExceeded();
        uint256 userRefund = handshake.escrowAmount - providerAmount;
        handshake.status = HandshakeStatus.Settled;
        _releaseEscrow(handshake.providerOperator, providerAmount);
        _releaseEscrow(handshake.userWallet, userRefund);
        emit HandshakeSettled(handshakeId, providerAmount, userRefund, settlementProofHash);
    }

    function _refreshProviderAnnouncementIfEarned(
        Handshake storage handshake,
        ProviderUpdate calldata update,
        uint256 providerAmount
    ) internal {
        if (providerAmount == 0) return;
        _validateProviderUpdate(update);
        if (offerIdFor(handshake.providerOperator, update.metadataHash) != handshake.providerOfferId) {
            revert InvalidSignature();
        }
        emit ProviderAnnounced(
            handshake.providerOperator,
            handshake.providerOfferId,
            update.metadataHash,
            update.metadataURI,
            uint64(block.number)
        );
    }

    function _openHandshakeForProvider(bytes32 handshakeId) internal view returns (Handshake storage handshake) {
        handshake = _openHandshakeForId(handshakeId);
        _requireProviderActor(handshake);
    }

    function _openHandshakeForId(bytes32 handshakeId) internal view returns (Handshake storage handshake) {
        handshake = _handshakes[handshakeId];
        if (handshake.status == HandshakeStatus.None) revert HandshakeNotFound();
        if (handshake.status != HandshakeStatus.Open) revert HandshakeNotOpen();
    }

    function _requireProviderActor(Handshake storage handshake) internal view {
        if (!_isProviderActor(handshake, msg.sender)) {
            revert Unauthorized();
        }
    }

    function _requireHandshakeActor(Handshake storage handshake) internal view {
        if (
            msg.sender != handshake.userWallet
                && msg.sender != handshake.userSessionSigner
                && !_isProviderActor(handshake, msg.sender)
        ) {
            revert Unauthorized();
        }
    }

    function _isProviderActor(Handshake storage handshake, address actor) internal view returns (bool) {
        return actor == handshake.providerOperator;
    }

    function _escrowFrom(address from, uint256 amount) internal {
        if (amount == 0) revert InvalidAmount();
        _callToken(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount)
        );
        escrowedSupply += amount;
    }

    function _releaseEscrow(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (to == address(0)) revert ZeroAddress();
        if (escrowedSupply < amount) revert InvalidAmount();
        escrowedSupply -= amount;
        _callToken(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
    }

    function _callToken(bytes memory callData) internal {
        (bool ok, bytes memory ret) = address(dToken).call(callData);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenTransferFailed();
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignature();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (uint256(s) > _SECP256K1_HALF_ORDER) revert InvalidSignature();
        if (v != 27 && v != 28) revert InvalidSignature();

        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0)) revert InvalidSignature();
        return recovered;
    }

    function _getImplementation() internal view returns (address implementation) {
        bytes32 slot = _IMPLEMENTATION_SLOT;
        assembly {
            implementation := sload(slot)
        }
    }

    function _upgradeToAndCall(address newImplementation, bytes memory data) internal {
        if (newImplementation == address(this) || newImplementation.code.length == 0) revert InvalidImplementation();
        (bool ok, bytes memory ret) =
            newImplementation.staticcall(abi.encodeWithSignature("proxiableUUID()"));
        if (!ok || ret.length != 32 || abi.decode(ret, (bytes32)) != _IMPLEMENTATION_SLOT) {
            revert InvalidImplementation();
        }
        bytes32 slot = _IMPLEMENTATION_SLOT;
        assembly {
            sstore(slot, newImplementation)
        }
        emit Upgraded(newImplementation);
        if (data.length > 0) {
            (bool success,) = newImplementation.delegatecall(data);
            if (!success) revert UpgradeCallFailed();
        }
    }
}
