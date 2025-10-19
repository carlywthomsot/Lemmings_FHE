pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract LemmingsFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct Lemming {
        euint32 ability; // Encrypted ability ID
        euint32 x;       // Encrypted x-coordinate
        euint32 y;       // Encrypted y-coordinate
    }
    mapping(uint256 => mapping(uint256 => Lemming)) public lemmings; // batchId -> lemmingId -> Lemming

    mapping(uint256 => uint256) public lemmingCountInBatch; // batchId -> count

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event LemmingSubmitted(address indexed provider, uint256 indexed batchId, uint256 indexed lemmingId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256[] abilities, uint256[] xs, uint256[] ys);

    error NotOwner();
    error NotProvider();
    error PausedState();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidBatchId();
    error InvalidLemmingId();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedState();
        _;
    }

    modifier respectCooldown(address user, mapping(address => uint256) storage cooldownMapping) {
        if (block.timestamp < cooldownMapping[user] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        _initIfNeeded();
    }

    function _initIfNeeded() internal {
        if (!FHE.isInitialized()) {
            FHE.initialize();
        }
    }

    function _requireInitialized() internal view {
        if (!FHE.isInitialized()) {
            revert("FHE not initialized");
        }
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused) {
            paused = true;
            emit Paused(msg.sender);
        } else {
            paused = false;
            emit Unpaused(msg.sender);
        }
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldown, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        isBatchOpen[currentBatchId] = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (!isBatchOpen[batchId]) revert BatchClosedOrInvalid();
        isBatchOpen[batchId] = false;
        emit BatchClosed(batchId);
    }

    function submitLemming(
        uint256 batchId,
        euint32 encryptedAbility,
        euint32 encryptedX,
        euint32 encryptedY
    ) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastSubmissionTime) {
        if (!isBatchOpen[batchId]) revert BatchClosedOrInvalid();

        uint256 lemmingId = ++lemmingCountInBatch[batchId];
        lemmings[batchId][lemmingId] = Lemming(encryptedAbility, encryptedX, encryptedY);

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit LemmingSubmitted(msg.sender, batchId, lemmingId);
    }

    function requestBatchDecryption(uint256 batchId) external onlyOwner whenNotPaused respectCooldown(msg.sender, lastDecryptionRequestTime) {
        if (lemmingCountInBatch[batchId] == 0) revert InvalidBatchId();

        uint256 numLemmings = lemmingCountInBatch[batchId];
        bytes32[] memory cts = new bytes32[](numLemmings * 3); // ability, x, y for each lemming

        uint256 ctsIdx;
        for (uint256 i = 1; i <= numLemmings; i++) {
            Lemming storage lemming = lemmings[batchId][i];
            cts[ctsIdx++] = lemming.ability.toBytes32();
            cts[ctsIdx++] = lemming.x.toBytes32();
            cts[ctsIdx++] = lemming.y.toBytes32();
        }

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        DecryptionContext storage context = decryptionContexts[requestId];

        // Replay Guard
        if (context.processed) revert ReplayAttempt();

        // State Verification
        uint256 numLemmings = lemmingCountInBatch[context.batchId];
        if (numLemmings == 0) revert InvalidBatchId(); // Should not happen if requestBatchDecryption checks

        bytes32[] memory currentCts = new bytes32[](numLemmings * 3);
        uint256 ctsIdx;
        for (uint256 i = 1; i <= numLemmings; i++) {
            Lemming storage lemming = lemmings[context.batchId][i];
            currentCts[ctsIdx++] = lemming.ability.toBytes32();
            currentCts[ctsIdx++] = lemming.x.toBytes32();
            currentCts[ctsIdx++] = lemming.y.toBytes32();
        }
        bytes32 currentHash = _hashCiphertexts(currentCts);

        if (currentHash != context.stateHash) {
            revert StateMismatch();
        }

        // Proof Verification
        FHE.checkSignatures(requestId, cleartexts, proof);

        // Decode & Finalize
        uint256[] memory abilities = new uint256[](numLemmings);
        uint256[] memory xs = new uint256[](numLemmings);
        uint256[] memory ys = new uint256[](numLemmings);

        uint256 cleartextIdx;
        for (uint256 i = 0; i < numLemmings; i++) {
            abilities[i] = abi.decode(cleartexts.slice(cleartextIdx, 32), (uint256));
            cleartextIdx += 32;
            xs[i] = abi.decode(cleartexts.slice(cleartextIdx, 32), (uint256));
            cleartextIdx += 32;
            ys[i] = abi.decode(cleartexts.slice(cleartextIdx, 32), (uint256));
            cleartextIdx += 32;
        }

        context.processed = true;
        emit DecryptionCompleted(requestId, context.batchId, abilities, xs, ys);
    }
}