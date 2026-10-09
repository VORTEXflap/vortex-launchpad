// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVortexFactory {
    function creditFee(address token) external payable;
    function addLiquidityReserve(address token) external payable;
}

interface IVortexToken {
    function onDebtCleared() external;
}

/**
 * @title VortexToken
 * @dev ERC-20 with a constant-product bonding curve over virtual BNB/token
 *      reserves. Launch-time configuration:
 *        tokenType 0 (税收模式): 可配置买/卖税率（0–10%）
 *        tokenType 1 (零税模式): 0 手续费交易，0.3% 曲线 LP 手续费偿还 Gas 债务
 *        protectSeconds: 防「挖提卖」保护期，期间禁止卖出
 *
 *      费用两阶段：
 *        Phase A（债务期）: 交易费全额路由至工厂，自动归还中继器垫付的 Gas 债务；
 *        Phase B（债清后）: 若配置了税收分配（创作者钱包/销毁/分红/流动性），
 *          交易税按比例持续分配；若分配全为 0，则税率归零（0 手续费终态）。
 */
contract VortexToken is ERC20, ReentrancyGuard {
    error NotFactory();
    error InvalidAmount();
    error TransferFailed();
    error SellProtected();
    error DevWindowActive();

    uint256 public constant VIRTUAL_BNB = 0.5e18;
    uint256 public constant VIRTUAL_TOKENS = 500_000e18;
    uint256 internal constant WAD = 1e18;

    address public immutable factory;
    string public immutable metadataURI;
    uint8 public immutable tokenType; // 0 = tax, 1 = zero-tax
    uint256 public immutable tradeOpensAt; // 保护期结束时间
    address public immutable creator; // 创建者
    uint256 public immutable devWindowEnd; // DEV 优先购买窗口结束时间

    // 税收分配（合计 100，零税模式强制 0）
    uint8 public immutable creatorPct; // 创作者资金钱包（开发者、营销等）
    uint8 public immutable burnPct; // 销毁（减少供应量压力）
    uint8 public immutable dividendPct; // 分红（持有者奖励）
    uint8 public immutable liquidityPct; // 流动性（增加流动性储备）
    address public immutable taxWallet; // 接收钱包（创作者份额去向）

    uint256 public virtualBnbReserve = VIRTUAL_BNB;
    uint256 public virtualTokenReserve = VIRTUAL_TOKENS;

    uint16 public buyFeeBps; // 买入税率（0–1000 = 0–10%）
    uint16 public sellFeeBps; // 卖出税率
    uint16 public curveFeeBps; // 曲线 LP 手续费（零税模式，债务清偿前）

    bool public debtCleared; // 由工厂在债务清偿后置位
    bool public feesDisabled; // 债清后无分配 → 永久 0 手续费

    // 分红：累计指数法（1e18 缩放），持有者随时间自动累计
    uint256 public dividendIndex;
    mapping(address => uint256) public pendingDividends;
    mapping(address => uint256) private dividendDebt;

    event Trade(address indexed trader, bool isBuy, uint256 bnbAmount, uint256 tokenAmount, uint256 fee);
    event FeesDisabled();
    event DividendsCredited(uint256 amount, uint256 newIndex);
    event DividendsClaimed(address indexed holder, uint256 amount);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        string memory metadataURI_,
        address factory_,
        uint8 tokenType_,
        uint8 buyTaxPct_, // 0–10
        uint8 sellTaxPct_, // 0–10
        uint32 protectSeconds_,
        address creator_,
        uint32 devWindow_, // DEV 优先购买窗口（秒，0 = 关闭）
        uint8 creatorPct_,
        uint8 burnPct_,
        uint8 dividendPct_,
        uint8 liquidityPct_,
        address taxWallet_
    ) ERC20(name_, symbol_) {
        factory = factory_;
        metadataURI = metadataURI_;
        tokenType = tokenType_;
        tradeOpensAt = block.timestamp + protectSeconds_;
        creator = creator_;
        devWindowEnd = block.timestamp + devWindow_;
        creatorPct = creatorPct_;
        burnPct = burnPct_;
        dividendPct = dividendPct_;
        liquidityPct = liquidityPct_;
        taxWallet = taxWallet_;
        if (tokenType_ == 1) {
            buyFeeBps = 0;
            sellFeeBps = 0;
            curveFeeBps = 30; // 0.3% LP fee until gas debt is cleared
        } else {
            buyFeeBps = uint16(buyTaxPct_) * 100;
            sellFeeBps = uint16(sellTaxPct_) * 100;
            curveFeeBps = 0;
        }
        _mint(address(this), totalSupply_); // whole supply sits in the curve
    }

    // ------------------------------------------------------------------ trades

    function buy() external payable nonReentrant {
        if (msg.value == 0) revert InvalidAmount();
        // DEV 优先购买窗口：开盘后一段时间内仅创建者可买入（FLAP 式防狙击）
        if (msg.sender != creator && block.timestamp < devWindowEnd) revert DevWindowActive();

        uint256 fee = (msg.value * (buyFeeBps + curveFeeBps)) / 10_000;
        uint256 bnbIn = msg.value - fee;
        uint256 tokensOut = getBuyTokens(bnbIn);
        if (tokensOut > balanceOf(address(this))) revert InvalidAmount();

        virtualBnbReserve += bnbIn;
        virtualTokenReserve -= tokensOut;
        _transfer(address(this), msg.sender, tokensOut);
        if (fee > 0) _routeFee(fee);

        emit Trade(msg.sender, true, bnbIn, tokensOut, fee);
    }

    function sell(uint256 tokensIn) external nonReentrant {
        if (tokensIn == 0) revert InvalidAmount();
        if (block.timestamp < tradeOpensAt) revert SellProtected(); // 防挖提卖保护期

        uint256 bnbOut = getSellBnb(tokensIn);
        uint256 fee = (bnbOut * (sellFeeBps + curveFeeBps)) / 10_000;
        uint256 net = bnbOut - fee;

        _transfer(msg.sender, address(this), tokensIn);
        virtualTokenReserve += tokensIn;
        virtualBnbReserve -= bnbOut;

        (bool ok, ) = msg.sender.call{value: net}("");
        if (!ok) revert TransferFailed();
        if (fee > 0) _routeFee(fee);

        emit Trade(msg.sender, false, bnbOut, tokensIn, fee);
    }

    // ---------------------------------------------------------------- fees

    function _routeFee(uint256 fee) internal {
        if (debtCleared || feesDisabled) {
            _distribute(fee);
        } else {
            // 债务期：全额送工厂偿还 Gas 债务；债清后工厂回调 onDebtCleared
            IVortexFactory(factory).creditFee{value: fee}(address(this));
        }
    }

    function _distribute(uint256 fee) internal {
        uint256 creatorShare = (fee * creatorPct) / 100;
        uint256 burnShare = (fee * burnPct) / 100;
        uint256 dividendShare = (fee * dividendPct) / 100;
        uint256 liquidityShare = (fee * liquidityPct) / 100;

        if (creatorShare > 0) {
            (bool ok, ) = taxWallet.call{value: creatorShare}("");
            if (!ok) revert TransferFailed();
        }
        if (burnShare > 0) {
            // 销毁份额打入黑洞地址，形成持续通缩压力
            (bool ok, ) = address(0xdEaD).call{value: burnShare}("");
            if (!ok) revert TransferFailed();
        }
        if (dividendShare > 0) _creditDividends(dividendShare);
        if (liquidityShare > 0) {
            IVortexFactory(factory).addLiquidityReserve{value: liquidityShare}(address(this));
        }
    }

    /** 工厂在 Gas 债务清偿后回调：有分配则持续收税，无分配则永久 0 手续费。 */
    function onDebtCleared() external {
        if (msg.sender != factory) revert NotFactory();
        if (debtCleared) return;
        debtCleared = true;
        if (creatorPct == 0 && burnPct == 0 && dividendPct == 0 && liquidityPct == 0) {
            buyFeeBps = 0;
            sellFeeBps = 0;
            curveFeeBps = 0;
            feesDisabled = true;
            emit FeesDisabled();
        }
    }

    // ------------------------------------------------------------ dividends

    function _settle(address account) internal {
        if (account == address(0) || account == address(this)) return;
        uint256 entitled = (balanceOf(account) * dividendIndex) / WAD;
        pendingDividends[account] += entitled - dividendDebt[account];
        dividendDebt[account] = entitled;
    }

    function _creditDividends(uint256 amount) internal {
        uint256 supply = totalSupply();
        if (supply == 0) return;
        dividendIndex += (amount * WAD) / supply;
        emit DividendsCredited(amount, dividendIndex);
    }

    /// 持有者领取累计分红（买卖时自动结算到账，也可主动领取）
    function claimDividends() external nonReentrant {
        _settle(msg.sender);
        uint256 amount = pendingDividends[msg.sender];
        if (amount == 0) return;
        pendingDividends[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit DividendsClaimed(msg.sender, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        _settle(from);
        _settle(to);
        super._update(from, to, value);
    }

    // ---------------------------------------------------------------- curve

    /// Constant-product curve: k = vB * vT, tokensOut = vT - k / (vB + bnbIn).
    function getBuyTokens(uint256 bnbIn) public view returns (uint256) {
        uint256 k = virtualBnbReserve * virtualTokenReserve;
        return virtualTokenReserve - k / (virtualBnbReserve + bnbIn);
    }

    /// bnbOut = vB - k / (vT + tokensIn).
    function getSellBnb(uint256 tokensIn) public view returns (uint256) {
        uint256 k = virtualBnbReserve * virtualTokenReserve;
        return virtualBnbReserve - k / (virtualTokenReserve + tokensIn);
    }

    /// BNB per token, 1e18-scaled.
    function getCurrentPrice() public view returns (uint256) {
        return (virtualBnbReserve * 1e18) / virtualTokenReserve;
    }
}

/**
 * @title VortexFactory
 * @dev Gasless launch factory with selectable launch modes. The creator only
 *      signs an EIP-712 LaunchRequest (0 手续费 + 0 Gas，由中继器代付);
 *      a relayer (or any executor) executes and fronts the BNB, repaid
 *      automatically from token fees via creditFee() until the per-launch
 *      gasDebt is cleared.
 *
 *      Launch modes (launchMode in the typed data):
 *        0 MODE_CURVE           税收 · 内盘曲线，直接发射
 *        1 MODE_ZERO_TAX        零税（0 手续费），直接发射
 *        2 MODE_CURVE_RESERVE   税收 · 保留 CA
 *        3 MODE_ZERO_TAX_RESERVE 零税 · 保留 CA
 *
 *      税收分配（creatorPct/burnPct/dividendPct/liquidityPct 合计 100，
 *      仅税收模式；零税模式强制全 0）：
 *        创作者钱包 → taxWallet；销毁 → 黑洞；分红 → 持有者累计；
 *        流动性 → 本合约按代币记录的流动性储备（后续接入 DEX 加池）。
 *
 *      EIP-712 domain — must match frontend/relayer exactly:
 *        name: "VortexFactory", version: "1",
 *        chainId: block.chainid, verifyingContract: address(this)
 *      Typed data:
 *        LaunchRequest(string name,string symbol,uint256 totalSupply,
 *          string metadataURI,address creator,uint256 nonce,uint256 deadline,
 *          uint8 launchMode,uint8 buyTaxBps,uint8 sellTaxBps,uint32 protectSeconds,
 *          uint8 creatorPct,uint8 burnPct,uint8 dividendPct,uint8 liquidityPct,
 *          address taxWallet)
 */
contract VortexFactory is EIP712, Ownable, ReentrancyGuard {
    uint8 public constant MODE_CURVE = 0;
    uint8 public constant MODE_ZERO_TAX = 1;
    uint8 public constant MODE_CURVE_RESERVE = 2;
    uint8 public constant MODE_ZERO_TAX_RESERVE = 3;

    uint8 public constant MAX_TAX_PCT = 10; // 税率上限 10%
    uint32 public constant MAX_PROTECT_SECONDS = 30 days; // 保护期上限 30 天
    uint32 public constant MAX_DEV_WINDOW = 24 hours; // DEV 优先购买窗口上限 24 小时

    error SignatureExpired();
    error InvalidSignature();
    error InvalidParams();
    error InvalidSupply();
    error InvalidMode();
    error InvalidTax();
    error InvalidDistribution();
    error NotLaunched();
    error NoReservation();
    error ParamsMismatch();
    error ExecutorRefundFailed();
    error SweepFailed();

    bytes32 private constant LAUNCH_TYPEHASH = keccak256(
        "LaunchRequest(string name,string symbol,uint256 totalSupply,string metadataURI,address creator,uint256 nonce,uint256 deadline,uint8 launchMode,uint8 buyTaxBps,uint8 sellTaxBps,uint32 protectSeconds,uint32 devWindow,uint8 creatorPct,uint8 burnPct,uint8 dividendPct,uint8 liquidityPct,address taxWallet)"
    );

    struct LaunchRequest {
        string name;
        string symbol;
        uint256 totalSupply;
        string metadataURI;
        address creator;
        uint256 nonce;
        uint256 deadline;
        uint8 launchMode;
        uint8 buyTaxBps;
        uint8 sellTaxBps;
        uint32 protectSeconds;
        uint32 devWindow;
        uint8 creatorPct;
        uint8 burnPct;
        uint8 dividendPct;
        uint8 liquidityPct;
        address taxWallet;
    }

    struct Launch {
        address token;
        address creator;
        address executor; // whoever paid the gas (normally the relayer)
        uint256 gasDebt; // BNB to recover from token fees
        uint256 gasRepaid;
        bool cleared;
    }

    struct Reservation {
        bytes32 paramsHash; // publish 时参数必须与保留时一致
        bytes32 salt;
        bool exists;
        bool published;
    }

    uint256 public gasCredit; // BNB reimbursed to the executor per launch
    uint256 public minSupply = 100_000e18;
    uint256 public maxSupply = 1_000_000_000_000e18;

    mapping(address => uint256) public nonces; // creator => EIP-712 nonce
    mapping(address => uint256) public reservationCount; // creator => reserved CA count
    mapping(address => Reservation) public reservations; // creator => active reservation
    mapping(address => Launch) public launches; // token => launch record
    mapping(address => uint256) public liquidityReserve; // token => 流动性储备（待接入 DEX 加池）

    event Launched(
        address indexed token,
        address indexed creator,
        address indexed executor,
        string name,
        string symbol,
        uint256 totalSupply,
        string metadataURI,
        uint256 gasDebt,
        uint8 launchMode
    );
    event CAReserved(
        address indexed ca,
        address indexed creator,
        string name,
        string symbol,
        string metadataURI,
        uint8 launchMode
    );
    event GasDebtCleared(address indexed token, address indexed executor, uint256 amount);
    event LiquidityReserveAdded(address indexed token, uint256 amount);

    constructor(uint256 gasCredit_) EIP712("VortexFactory", "1") Ownable(msg.sender) {
        gasCredit = gasCredit_;
    }

    function _tokenType(uint8 launchMode) internal pure returns (uint8) {
        return (launchMode == MODE_ZERO_TAX || launchMode == MODE_ZERO_TAX_RESERVE) ? 1 : 0;
    }

    function _isReserve(uint8 launchMode) internal pure returns (bool) {
        return launchMode == MODE_CURVE_RESERVE || launchMode == MODE_ZERO_TAX_RESERVE;
    }

    /// 接收钱包归一化：未填写时默认为创建者地址
    function _taxWallet(LaunchRequest calldata req) internal pure returns (address) {
        return req.taxWallet == address(0) ? req.creator : req.taxWallet;
    }

    function _validateParams(LaunchRequest calldata req) internal view {
        if (bytes(req.name).length == 0 || bytes(req.name).length > 32) revert InvalidParams();
        if (bytes(req.symbol).length == 0 || bytes(req.symbol).length > 10) revert InvalidParams();
        if (req.totalSupply < minSupply || req.totalSupply > maxSupply) revert InvalidSupply();
        if (req.launchMode > MODE_ZERO_TAX_RESERVE) revert InvalidMode();
        if (req.buyTaxBps > MAX_TAX_PCT || req.sellTaxBps > MAX_TAX_PCT) revert InvalidTax();
        if (req.protectSeconds > MAX_PROTECT_SECONDS) revert InvalidParams();
        if (req.devWindow > MAX_DEV_WINDOW) revert InvalidParams();

        uint256 sum = uint256(req.creatorPct) + req.burnPct + req.dividendPct + req.liquidityPct;
        if (_tokenType(req.launchMode) == 1) {
            // 零税模式：无交易税，不允许税收分配
            if (sum != 0) revert InvalidDistribution();
        } else {
            // 税收模式：分配合计必须为 100
            if (sum != 100) revert InvalidDistribution();
        }
    }

    function _verify(LaunchRequest calldata req, bytes calldata signature, uint256 nonce) internal view {
        if (block.timestamp > req.deadline) revert SignatureExpired();
        bytes32 structHash = keccak256(
            abi.encode(
                LAUNCH_TYPEHASH,
                keccak256(bytes(req.name)),
                keccak256(bytes(req.symbol)),
                req.totalSupply,
                keccak256(bytes(req.metadataURI)),
                req.creator,
                nonce,
                req.deadline,
                req.launchMode,
                req.buyTaxBps,
                req.sellTaxBps,
                req.protectSeconds,
                req.devWindow,
                req.creatorPct,
                req.burnPct,
                req.dividendPct,
                req.liquidityPct,
                req.taxWallet
            )
        );
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != req.creator) {
            revert InvalidSignature();
        }
    }

    function _paramsHash(LaunchRequest calldata req) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                req.name,
                req.symbol,
                req.totalSupply,
                req.metadataURI,
                req.launchMode,
                req.buyTaxBps,
                req.sellTaxBps,
                req.protectSeconds,
                req.devWindow,
                req.creatorPct,
                req.burnPct,
                req.dividendPct,
                req.liquidityPct,
                req.taxWallet
            )
        );
    }

    function _deploy(LaunchRequest calldata req, bytes32 salt) internal returns (address token) {
        token = Create2.deploy(
            0,
            salt,
            abi.encodePacked(
                type(VortexToken).creationCode,
                abi.encode(
                    req.name,
                    req.symbol,
                    req.totalSupply,
                    req.metadataURI,
                    address(this),
                    _tokenType(req.launchMode),
                    req.buyTaxBps,
                    req.sellTaxBps,
                    req.protectSeconds,
                    req.creator,
                    req.devWindow,
                    req.creatorPct,
                    req.burnPct,
                    req.dividendPct,
                    req.liquidityPct,
                    _taxWallet(req)
                )
            )
        );
    }

    /// 直接发射（模式 0 / 1）
    function launch(LaunchRequest calldata req, bytes calldata signature)
        external
        nonReentrant
        returns (address token)
    {
        if (_isReserve(req.launchMode)) revert InvalidMode();
        _validateParams(req);
        uint256 nonce = nonces[req.creator]++;
        _verify(req, signature, nonce);

        bytes32 salt = keccak256(abi.encodePacked(req.creator, nonce));
        token = _deploy(req, salt);

        launches[token] = Launch(token, req.creator, msg.sender, gasCredit, 0, false);
        emit Launched(token, req.creator, msg.sender, req.name, req.symbol, req.totalSupply, req.metadataURI, gasCredit, req.launchMode);
    }

    /// 保留 CA：先锁定可预测的代币合约地址（模式 2 / 3）
    function reserveCA(LaunchRequest calldata req, bytes calldata signature) external returns (address ca) {
        if (!_isReserve(req.launchMode)) revert InvalidMode();
        _validateParams(req);
        uint256 nonce = nonces[req.creator]++;
        _verify(req, signature, nonce);

        bytes32 salt = keccak256(abi.encodePacked(req.creator, reservationCount[req.creator]++));
        reservations[req.creator] = Reservation(_paramsHash(req), salt, true, false);

        ca = Create2.computeAddress(
            salt,
            keccak256(
                abi.encodePacked(
                    type(VortexToken).creationCode,
                    abi.encode(
                        req.name,
                        req.symbol,
                        req.totalSupply,
                        req.metadataURI,
                        address(this),
                        _tokenType(req.launchMode),
                        req.buyTaxBps,
                        req.sellTaxBps,
                        req.protectSeconds,
                        req.creatorPct,
                        req.burnPct,
                        req.dividendPct,
                        req.liquidityPct,
                        _taxWallet(req)
                    )
                )
            ),
            address(this)
        );
        emit CAReserved(ca, req.creator, req.name, req.symbol, req.metadataURI, req.launchMode);
    }

    /// 发布已保留的 CA（模式 2 / 3，参数必须与保留时一致）
    function publish(LaunchRequest calldata req, bytes calldata signature)
        external
        nonReentrant
        returns (address token)
    {
        if (!_isReserve(req.launchMode)) revert InvalidMode();
        Reservation storage r = reservations[req.creator];
        if (!r.exists || r.published) revert NoReservation();
        if (r.paramsHash != _paramsHash(req)) revert ParamsMismatch();

        uint256 nonce = nonces[req.creator]++;
        _verify(req, signature, nonce);
        r.published = true;

        token = _deploy(req, r.salt);
        launches[token] = Launch(token, req.creator, msg.sender, gasCredit, 0, false);
        emit Launched(token, req.creator, msg.sender, req.name, req.symbol, req.totalSupply, req.metadataURI, gasCredit, req.launchMode);
    }

    /// 下一次保留 CA 时可预测的地址（供 UI 预展示）
    function predictedCA(
        address creator,
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        string calldata metadataURI,
        uint8 launchMode,
        uint8 buyTaxBps,
        uint8 sellTaxBps,
        uint32 protectSeconds,
        uint32 devWindow,
        uint8 creatorPct,
        uint8 burnPct,
        uint8 dividendPct,
        uint8 liquidityPct,
        address taxWallet
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(creator, reservationCount[creator]));
        return Create2.computeAddress(
            salt,
            keccak256(
                abi.encodePacked(
                    type(VortexToken).creationCode,
                    abi.encode(
                        name, symbol, totalSupply, metadataURI, address(this), _tokenType(launchMode),
                        buyTaxBps, sellTaxBps, protectSeconds, creator, devWindow,
                        creatorPct, burnPct, dividendPct, liquidityPct,
                        taxWallet == address(0) ? creator : taxWallet
                    )
                )
            ),
            address(this)
        );
    }

    /// Called by a token's fee path (debt phase). Repays the executor's gas
    /// debt; when cleared, notifies the token to switch to distribution mode.
    /// Surplus beyond the debt stays in the factory as protocol revenue.
    function creditFee(address token) external payable {
        Launch storage l = launches[token];
        if (l.token == address(0)) revert NotLaunched();
        if (msg.value == 0 || l.cleared) return;

        uint256 remaining = l.gasDebt - l.gasRepaid;
        uint256 credit = msg.value < remaining ? msg.value : remaining;
        l.gasRepaid += credit;

        (bool ok, ) = l.executor.call{value: credit}("");
        if (!ok) revert ExecutorRefundFailed();

        if (l.gasRepaid >= l.gasDebt) {
            l.cleared = true;
            IVortexToken(token).onDebtCleared();
            emit GasDebtCleared(token, l.executor, l.gasRepaid);
        }
    }

    /// 债清后代币的「流动性」分配份额进入本合约的储备，后续接入 DEX 加池。
    function addLiquidityReserve(address token) external payable {
        if (launches[token].token == address(0)) revert NotLaunched();
        liquidityReserve[token] += msg.value;
        emit LiquidityReserveAdded(token, msg.value);
    }

    /// 提取指定代币的流动性储备（仅 owner；用于后续 DEX 加池操作）
    function withdrawLiquidityReserve(address token, address payable to) external onlyOwner {
        uint256 amount = liquidityReserve[token];
        liquidityReserve[token] = 0;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert SweepFailed();
    }

    function setGasCredit(uint256 gasCredit_) external onlyOwner {
        gasCredit = gasCredit_;
    }

    function setSupplyBounds(uint256 min_, uint256 max_) external onlyOwner {
        if (min_ == 0 || max_ < min_) revert InvalidSupply();
        minSupply = min_;
        maxSupply = max_;
    }

    function sweep(address payable to) external onlyOwner {
        (bool ok, ) = to.call{value: address(this).balance}("");
        if (!ok) revert SweepFailed();
    }
}
