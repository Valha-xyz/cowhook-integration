const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { ethers } = require('ethers');
const ERC20ABI = require('./ERC20ABI.json');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(bodyParser.raw());
const port = 4242;

// ENV VARIABLE
const BEARER_TOKEN = '';
const RPC_PROVIDERS = {
  ethereum: '',
  gnosis: '',
};

// CONST VARIABLE
const routerAddress = '0xc92e8bdf79f0507f65a392b0ab4667716bfe0110';
const API_QUOTE_ROUTE = {
  ethereum: 'https://api.cow.fi/mainnet/api/v1/quote',
  gnosis: 'https://api.cow.fi/xdai/api/v1/quote',
};
const validity_timestamp = parseInt(
  String(new Date().getTime() / 1000 + 60 * 15)
);
const SLIPPAGE = 0.7 / 100;
const ROUTER_ADDRESS = '0xc92e8bdf79f0507f65a392b0ab4667716bfe0110';
const HOOK_RELAYER = {
  ethereum: '0x01dcb88678aedd0c4cc9552b20f4718550250574',
  gnosis: '0x01dcb88678aedd0c4cc9552b20f4718550250574',
};

/// Helpers Function

async function getGasPrice(provider) {
  // Get the gas price from the provider
  const { gasPrice } = await provider.getFeeData();
  const ret =
    ((BigInt(gasPrice) ?? BigInt(0)) * BigInt('1050')) / BigInt('1000');

  return '0x' + ret.toString(16);
}

async function generateOneApproval(
  token,
  ABI,
  provider,
  userAddress,
  amount,
  addressToApprove
) {
  console.log(token);
  const Token = new ethers.BaseContract(token, ABI, provider);
  const tx = await Token.approve.populateTransaction(addressToApprove, amount);
  return {
    from: userAddress,
    to: token,
    data: tx.data,
    value: '0x00',
    gasPrice: await getGasPrice(provider),
  };
}

function truncateToStringDecimals(num, dec) {
  const calcDec = Math.pow(10, Number(dec));
  return String(Math.trunc(num * calcDec) / calcDec);
}

function getEncodedData(abi, fnName, argsValue) {
  const iface = new ethers.Interface(abi);
  const res = iface.encodeFunctionData(fnName, argsValue);
  return res;
}

async function erc20Decimals(provider, tokenAddress) {
  try {
    const ERC20 = new ethers.Contract(tokenAddress, ERC20ABI, provider);
    const decimals = await ERC20.decimals();
    return decimals;
  } catch (err) {
    return 0;
  }
}

async function toBnERC20Decimals(amount, chain, tokenAddress) {
  try {
    const parsedAmount = parseFloat(amount);
    if (parsedAmount < 0 || isNaN(parsedAmount)) {
      throw new Error(`Error while parsing ${amount}`);
    }
    let decimals = 18;
    if (
      tokenAddress.toLowerCase() !==
      String('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE').toLowerCase()
    ) {
      const provider = getNodeProvider(chain);
      if (provider == null) throw new Error('No provider was found.');
      decimals = await erc20Decimals(provider, tokenAddress.toLowerCase());
    }

    const amountExactDecimals = truncateToStringDecimals(
      parsedAmount.toString(),
      decimals
    );
    return ethers.parseUnits(amountExactDecimals, decimals).toString();
  } catch (err) {
    console.log(err);
    return null;
  }
}

function getNodeProvider(chain) {
  try {
    const URL = RPC_PROVIDERS[chain];
    if (!URL) throw new Error(`Provider URL not found for ${chain}`);
    const provider = new ethers.JsonRpcProvider(URL);
    return provider;
  } catch (err) {
    console.log(err);
    return null;
  }
}

/// Valha Post Function
async function getValhaCalldata(chain, poolAddress, user, amount, action) {
  try {
    const payload = {
      user: user,
      amount: amount,
      disable_check: true,
    };

    const result = await axios.post(
      `https://api.valha.xyz/v0/${chain}/pools/${poolAddress}/${action.toLowerCase()}`,
      payload,
      {
        headers: {
          authorization: `Bearer ${BEARER_TOKEN}`,
        },
      }
    );
    if (result.err) throw new Error();

    return result.data;
  } catch (err) {
    console.log(err.response.data.err);
    return null;
  }
}

/// Main Function
/// The useRouter boolean let the choice to the user to either use the Hooks and make the action in 2 clicks
/// or to make hte action in 4 clicks without taking the risk of interaction slippage. But it won't be necessary in phase 2.
async function getTx(
  chain,
  poolAddress,
  user,
  amount,
  action,
  useRouter,
  swapToken
) {
  /// We get the pool information from Valha API
  const poolInfoData = await axios.get(
    `https://api.valha.xyz/v0/${chain}/pools/${poolAddress}`,
    {
      headers: {
        authorization: `Bearer ${BEARER_TOKEN}`,
      },
    }
  );
  if (poolInfoData.err) throw new Error();
  const poolInfo = poolInfoData.data.data[0];

  console.log(poolInfo);

  const provider = getNodeProvider(chain);

  /// If the pool is denominated in native token, we only swap as liquidity is good for most ERC20 project in native
  /// and CoW does not handle native token.

  if ((action === 'deposit' || action === 'deposit_and_stake') && useRouter) {
    tokenIn = swapToken;
    tokenOut = poolInfo.underlying_tokens[0].address;

    console.log(tokenIn);
    console.log(chain);
    const amountBnString = await toBnERC20Decimals(
      String(amount),
      chain,
      tokenIn
    );

    console.log(amountBnString);

    /// We generate a dummy hook to have an estimation of how much token we will receive and to take into account gas fees paid in underlying.
    /// WARNING: The gas limit is put arbitrary for now to ensure good UX, must be parameterized in phase 2.
    const dummyHook = [
      {
        target: '0x45E954acf1Efc374478dF69B45f12AEFD8AE51a3',
        callData:
          '0x0000000000000000000000000000000000000000000000000000000000000042',
        gasLimit: '800000',
      },
    ];

    const relayer = HOOK_RELAYER[chain];

    const payload = {
      sellToken: tokenIn,
      buyToken: tokenOut,
      receiver: relayer,
      validTo: validity_timestamp,
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
      from: user,
      kind: 'sell',
      sellAmountBeforeFee: amountBnString,
      appData: JSON.stringify({
        metadata: {
          hooks: {
            pre: [],
            post: dummyHook,
          },
        },
      }),
    };
    const res = await axios.post(API_QUOTE_ROUTE[chain], payload);

    if (!res.data) {
      throw new BadRequestException(
        'Error in getting the quote price from CoWSwap'
      );
    }
    const data = res.data;

    const tokenInDecimals = Number(await erc20Decimals(provider, tokenIn));
    const tokenOutDecimals = Number(await erc20Decimals(provider, tokenOut));
    const amountResult =
      parseFloat(data.quote.buyAmount) / 10 ** tokenOutDecimals;

    const amountWithSlippage = parseFloat(
      Number(amountResult * (1 - SLIPPAGE)).toFixed(tokenOutDecimals)
    );

    /// Generate calldata based on quote price and put the hook relayer as the address executing the call
    const tx = await getValhaCalldata(
      chain,
      poolAddress,
      relayer,
      amount,
      action
    );

    // Based on share_price of the protocol
    const sharePrice = poolInfo.pool_analytics.share_price[0];
    if (!sharePrice || sharePrice === 0) {
      throw new BadRequestException();
    }

    /// We put a slippage on the interaction to make sure the transaction is passing.
    /// Warning: to be done on a specific smart contract in phase 2.
    const amountToReceiveFromProtocol =
      (amountWithSlippage / sharePrice) * (1 - (SLIPPAGE + 0.02));

    const amountToReceive = await toBnERC20Decimals(
      String(amountToReceiveFromProtocol),
      chain,
      poolAddress
    );

    const erc20TransferData = getEncodedData(ERC20ABI, 'transfer', [
      user,
      amountToReceive,
    ]);
    const erc20Transfer = {
      target: poolAddress,
      callData: erc20TransferData,
      // Approximate gas limit determined with Tenderly.
      gasLimit: '120000',
    };

    console.log(tx);

    const hooks = [
      {
        target: tx.data?.approveTx?.[0].to,
        callData: tx.data?.approveTx?.[0].data,
        // Approximate gas limit determined with Tenderly.
        gasLimit: tx.data?.approveTx?.[0].gasLimit ?? '250000',
      },
      {
        target: tx.data.interactionTx.to,
        callData: tx.data.interactionTx.data,
        // Approximate gas limit determined with Tenderly.
        gasLimit: tx.data.interactionTx.gasLimit ?? '450000',
      },
      erc20Transfer,
      // erc20TransferShield0,
    ];

    // getActionType to Sign
    let approvalTx;
    let interactionSignature;

    // create signature based on payload posthook
    const payloadHook = {
      sellToken: tokenIn,
      buyToken: tokenOut,
      receiver: relayer,
      validTo: validity_timestamp,
      appData: JSON.stringify({
        metadata: {
          hooks: {
            pre: [],
            post: hooks,
          },
        },
      }),
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
      from: user,
      kind: 'sell',
      sellAmountBeforeFee: amountBnString,
    };
    const cowRes = await axios.post(API_QUOTE_ROUTE[chain], payloadHook);

    if (!cowRes.data) {
      throw new BadRequestException(
        'Error in getting the quote price from CoWSwap'
      );
    }
    const cowData = cowRes.data;
    interactionSignature = {
      ...cowData.quote,
      buyAmount: String(
        parseInt(String(data.quote.buyAmount * (1 - SLIPPAGE)))
      ),
      appData: cowData.quote.appData,
      appDataHash: ethers.id(cowData.quote.appData),
    };

    // generate approval
    approvalTx = await generateOneApproval(
      tokenIn,
      ERC20ABI,
      provider,
      user,
      amountBnString,
      routerAddress
    );

    const feeAmountDepositBN = data.quote.feeAmount;
    const feeAmountDeposit = feeAmountDepositBN / 10 ** Number(tokenInDecimals);

    return {
      data: {
        approveTx: [approvalTx],
        interactionSignature: {
          fees: feeAmountDeposit,
          signature: interactionSignature,
        },
      },
      err: null,
    };
  } else if (
    (action === 'deposit' || action === 'deposit_and_stake') &&
    !useRouter
  ) {
    tokenIn = swapToken;
    tokenOut = poolInfo.underlying_tokens[0].address;

    const shortValidityTimestamp = parseInt(
      String(new Date().getTime() / 1000 + 60 * 2)
    );
    // generate a cowswapSignature and an approval
    const amountBn = await toBnERC20Decimals(String(amount), chain, tokenIn);
    const relayerApprovalTx = await generateOneApproval(
      tokenIn,
      ERC20ABI,
      provider,
      user,
      amountBn,
      routerAddress,
      true,
      false,
      false
    );

    const payloadHook = {
      sellToken: tokenIn,
      buyToken: tokenOut,
      receiver: user,
      validTo: shortValidityTimestamp,
      appData: JSON.stringify({
        metadata: {
          hooks: {
            pre: [],
            post: [],
          },
        },
      }),
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
      from: user,
      kind: 'sell',
      sellAmountBeforeFee: amountBn,
    };
    const res = await axios.post(API_QUOTE_ROUTE[chain], payloadHook);
    if (!res.data) {
      throw new BadRequestException(
        'Error in getting the quote price from CoWSwap'
      );
    }
    const data = res.data;

    // calculate the amount minimum receive from the swap and deposit this minimum
    const amountToReceiveBN = data.quote.buyAmount * (1 - SLIPPAGE);
    const poolDecimals = await erc20Decimals(provider, tokenOut);
    const amountToReceive = amountToReceiveBN / 10 ** Number(poolDecimals);

    // get tx for redeem for users with approval
    const tx = await getValhaCalldata(
      chain,
      poolAddress,
      user,
      amountToReceive,
      action
    );

    // structure and return object like the redeem
    const interactionSignature = {
      ...data.quote,
      buyAmount: String(
        parseInt(String(data.quote.buyAmount * (1 - SLIPPAGE)))
      ),
      appData: data.quote.appData,
      appDataHash: ethers.id(data.quote.appData),
    };

    const tokenInDecimals = await erc20Decimals(provider, tokenIn);
    const feeAmountActionBN = data.quote.feeAmount;
    const feeAmountAction = feeAmountActionBN / 10 ** Number(tokenInDecimals);

    const ret = {
      protocolTxs: tx.data,
      cowswapTxs: {
        approvalTx: relayerApprovalTx,
        swapSignature: {
          fees: feeAmountAction,
          signature: interactionSignature,
        },
      },
    };

    return { data: ret, err: null };
  } else if (action === 'redeem') {
    const tx = await getValhaCalldata(chain, poolAddress, user, amount, action);

    const sharePrice = poolInfo.pool_analytics.share_price[0];
    const amountToGet = amount * sharePrice * (1 - SLIPPAGE);

    // generate approval
    const amountBnApproval = await toBnERC20Decimals(
      String(amountToGet),
      chain,
      poolInfo?.underlying_tokens[0].address
    );
    const relayerApprovalTx = await generateOneApproval(
      poolInfo?.underlying_tokens[0].address,
      ERC20ABI,
      provider,
      user,
      amountBnApproval,
      routerAddress
    );
    // generate a cowswapSignature for the amount with a small slippage

    const sellToken = poolInfo?.underlying_tokens[0].address;

    const payloadHook = {
      sellToken: sellToken,
      buyToken: swapToken,
      receiver: user,
      validTo: validity_timestamp,
      appData: JSON.stringify({
        metadata: {
          hooks: {
            pre: [],
            post: [],
          },
        },
      }),
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
      from: user,
      kind: 'sell',
      sellAmountBeforeFee: amountBnApproval,
    };
    const res = await axios.post(API_QUOTE_ROUTE[chain], payloadHook);
    if (!res.data) {
      throw new BadRequestException(
        'Error in getting the quote price from CoWSwap'
      );
    }
    const data = res.data;
    const interactionSignature = {
      ...data.quote,
      buyAmount: String(
        parseInt(String(data.quote.buyAmount * (1 - SLIPPAGE)))
      ),
      appData: data.quote.appData,
      appDataHash: ethers.id(data.quote.appData),
    };

    const tokenInDecimals = await erc20Decimals(provider, sellToken);
    const feeAmountActionBN = data.quote.feeAmount;
    const feeAmountAction = feeAmountActionBN / 10 ** Number(tokenInDecimals);

    const ret = {
      protocolTxs: tx.data,
      cowswapTxs: {
        approvalTx: relayerApprovalTx,
        swapSignature: {
          fees: feeAmountAction,
          signature: interactionSignature,
        },
      },
    };

    return { data: ret, err: null };
  }
}

app.post('/tx', async (req, res) => {
  // get the information from the request
  const {
    chain,
    poolAddress,
    userAddress,
    amount,
    action,
    useRouter,
    swapToken,
  } = req.body;

  // // get the JSON request here
  const result = await getTx(
    chain,
    poolAddress,
    userAddress,
    amount,
    action,
    useRouter,
    swapToken
  );

  if (!result) {
    res.status(400).json({
      data: null,
      err: 'There was an error while generating the data.',
    });
  }

  res.status(200).json(result);
});

app.get('/', (req, res) => {
  res.send(
    'Please post something on the `/tx` route with a payload containing: chain, poolAddress, user, amount, action, useRouter, swapToken '
  );
});

app.listen(port, () => {
  console.log(`The app is listening on port ${port}`);
});
