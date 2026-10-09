// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IPortal
 * @notice FLAP Portal 接口（仅声明用到的部分）
 *         主网: 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0
 */
interface IPortal {
    struct NewTokenV6Params {
        string name;
        string symbol;
        string meta;
        uint8 dexThresh;
        bytes32 salt;
        uint8 migratorType;
        address quoteToken;
        uint256 quoteAmt;
        address beneficiary;
        bytes permitData;
        bytes32 extensionID;
        bytes extensionData;
        uint8 dexId;
        uint8 lpFeeProfile;
        uint16 buyTaxRate;
        uint16 sellTaxRate;
        uint64 taxDuration;
        uint64 antiFarmerDuration;
        uint16 mktBps;
        uint16 deflationBps;
        uint16 dividendBps;
        uint16 lpBps;
        uint256 minimumShareBalance;
        address dividendToken;
        address commissionReceiver;
        uint8 tokenVersion;
    }

    function newTokenV6(NewTokenV6Params calldata params) external payable returns (address token);
}

/**
 * @title VortexRelayer
 * @notice Vortex 发射中继合约：作为对外可见、可验证的发射入口。
 *
 * 链路：热钱包(EOA, 付 gas) → 本合约 → FLAP Portal
 * 价值：
 *   1. 链上有已开源验证的合约身份（比裸钱包地址可信）
 *   2. 每次发射 emit LaunchSponsored 事件 → 上链可查、不可篡改，看板可据此索引
 *   3. 权限控制：只有 owner 授权的 operator 才能触发发射（热钱包私钥泄露时多一层保护）
 *   4. 代币归属：beneficiary 强制为参数指定地址（即真实创建者）
 */
contract VortexRelayer {
    /// @notice FLAP Portal 地址（不可变）
    address public immutable portal;

    /// @notice 合约所有者（部署者）
    address public owner;

    /// @notice 授权的中继器操作员（通常是 Vortex 热钱包地址）
    mapping(address => bool) public operators;

    /// @notice 单次发射的 value 上限，防止误操作/攻击者耗尽合约余额
    uint256 public maxValuePerLaunch;

    /// @notice 合约是否暂停
    bool public paused;

    /// @notice 单笔 Gas 返还上限
    uint256 public maxRefundPerTx;

    /// @notice 已返还过 Gas 的源交易哈希（防重复返还）
    mapping(bytes32 => bool) public refunded;

    /// @notice 累计返还的 Gas 总额
    uint256 public totalRefunded;

    event LaunchSponsored(
        address indexed token,
        address indexed creator,
        address indexed operator,
        uint256 value,
        uint256 ts
    );
    event OperatorSet(address indexed operator, bool allowed);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event MaxValueChanged(uint256 previous, uint256 current);
    event PausedSet(bool paused);
    event Withdrawn(address indexed to, uint256 amount);
    event GasRefunded(address indexed to, uint256 amount, bytes32 indexed sourceTxHash, uint256 ts);

    error NotOwner();
    error NotOperator();
    error IsPaused();
    error ValueTooHigh(uint256 provided, uint256 max);
    error TransferFailed();
    error AlreadyRefunded();
    error RefundTooHigh(uint256 amount, uint256 max);
    error InvalidRecipient();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != owner && !operators[msg.sender]) revert NotOperator();
        _;
    }

    constructor(address portal_, address initialOperator, uint256 maxValuePerLaunch_) {
        require(portal_ != address(0), "portal=0");
        portal = portal_;
        owner = msg.sender;
        maxValuePerLaunch = maxValuePerLaunch_;
        maxRefundPerTx = 0.01 ether; // 默认单笔返还上限 0.01 BNB
        if (initialOperator != address(0)) {
            operators[initialOperator] = true;
            emit OperatorSet(initialOperator, true);
        }
    }

    /**
     * @notice 代付并发射代币。由中继器（热钱包）调用，代币直接归属 params.beneficiary
     * @dev value 由调用方携带（当前 FLAP 创建费为 0，仅需 gas）；ETH 不足时会 revert
     */
    function sponsorLaunch(IPortal.NewTokenV6Params calldata params)
        external
        payable
        onlyOperator
        returns (address token)
    {
        if (paused) revert IsPaused();
        if (msg.value > maxValuePerLaunch) revert ValueTooHigh(msg.value, maxValuePerLaunch);
        require(params.beneficiary != address(0), "beneficiary=0");

        token = IPortal(portal).newTokenV6{value: msg.value}(params);

        emit LaunchSponsored(token, params.beneficiary, msg.sender, msg.value, block.timestamp);
    }

    /**
     * @notice Gas 返还：用户在网站上「自己发币」（创建者显示为用户本人）时垫付了 gas，
     *         中继器调用本函数把 gas 全额退还给创建者，链上留痕、可公开验证。
     * @dev 由中继器携带 value 调用（钱来自中继器资金），合约转发并记录事件；
     *      sourceTxHash 为用户那笔发币交易哈希，用于防止重复返还。
     */
    function refundGas(address payable to, bytes32 sourceTxHash)
        external
        payable
        onlyOperator
    {
        if (to == address(0)) revert InvalidRecipient();
        if (msg.value == 0) revert TransferFailed();
        if (refunded[sourceTxHash]) revert AlreadyRefunded();
        if (msg.value > maxRefundPerTx) revert RefundTooHigh(msg.value, maxRefundPerTx);

        refunded[sourceTxHash] = true;
        totalRefunded += msg.value;

        (bool ok, ) = to.call{value: msg.value}("");
        if (!ok) revert TransferFailed();

        emit GasRefunded(to, msg.value, sourceTxHash, block.timestamp);
    }

    /// @notice 中继器一次性校验多笔返还是否可执行（供前端预检查）
    function canRefund(bytes32 sourceTxHash, uint256 amount) external view returns (bool) {
        return !refunded[sourceTxHash] && amount > 0 && amount <= maxRefundPerTx;
    }

    // ---------------------------------------------------------------- admin

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function setMaxRefundPerTx(uint256 value) external onlyOwner {
        maxRefundPerTx = value;
    }

    function setMaxValuePerLaunch(uint256 value) external onlyOwner {
        emit MaxValueChanged(maxValuePerLaunch, value);
        maxValuePerLaunch = value;
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner=0");
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /// @notice 提取合约余额（合约只在中继器预存资金时才有余额）
    function withdraw(address to) external onlyOwner {
        (bool ok, ) = to.call{value: address(this).balance}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, address(this).balance);
    }

    receive() external payable {}
}
