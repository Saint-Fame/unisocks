import React, { useState, useCallback, useEffect } from 'react'
import { useWeb3Context } from 'web3-react'
import { ethers } from 'ethers'

import { TOKEN_SYMBOLS, TOKEN_ADDRESSES, ERROR_CODES, amountFormatter } from '../../utils'
import { useTokenContract, useExchangeContract, useAddressBalance, useAddressAllowance } from '../../hooks'
import Body from '../Body'

// denominated in bips
const GAS_MARGIN = ethers.utils.bigNumberify(1000)

export function calculateGasMargin(value, margin) {
  const offset = value.mul(margin).div(ethers.utils.bigNumberify(10000))
  return value.add(offset)
}

// denominated in seconds
const DEADLINE_FROM_NOW = 60 * 15

// denominated in bips
const ALLOWED_SLIPPAGE = ethers.utils.bigNumberify(200)

function calculateSlippageBounds(value) {
  const offset = value.mul(ALLOWED_SLIPPAGE).div(ethers.utils.bigNumberify(10000))
  const minimum = value.sub(offset)
  const maximum = value.add(offset)
  return {
    minimum: minimum.lt(ethers.constants.Zero) ? ethers.constants.Zero : minimum,
    maximum: maximum.gt(ethers.constants.MaxUint256) ? ethers.constants.MaxUint256 : maximum
  }
}

// this mocks the getInputPrice function, and calculates the required output
function calculateEtherTokenOutputFromInput(inputAmount, inputReserve, outputReserve) {
  const inputAmountWithFee = inputAmount.mul(ethers.utils.bigNumberify(997))
  const numerator = inputAmountWithFee.mul(outputReserve)
  const denominator = inputReserve.mul(ethers.utils.bigNumberify(1000)).add(inputAmountWithFee)
  return numerator.div(denominator)
}

// this mocks the getOutputPrice function, and calculates the required input
function calculateEtherTokenInputFromOutput(outputAmount, inputReserve, outputReserve) {
  const numerator = inputReserve.mul(outputAmount).mul(ethers.utils.bigNumberify(1000))
  const denominator = outputReserve.sub(outputAmount).mul(ethers.utils.bigNumberify(997))
  return numerator.div(denominator).add(ethers.constants.One)
}

// get exchange rate for a token/ETH pair
function getExchangeRate(inputValue, outputValue, invert = false) {
  const inputDecimals = 18
  const outputDecimals = 18

  if (inputValue && inputDecimals && outputValue && outputDecimals) {
    const factor = ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(18))

    if (invert) {
      return inputValue
        .mul(factor)
        .div(outputValue)
        .mul(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(outputDecimals)))
        .div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(inputDecimals)))
    } else {
      return outputValue
        .mul(factor)
        .div(inputValue)
        .mul(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(inputDecimals)))
        .div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(outputDecimals)))
    }
  }
}

function calculateAmount(
  inputTokenSymbol,
  outputTokenSymbol,
  SOCKSAmount,
  reserveSOCKSETH,
  reserveSOCKSToken,
  reserveSelectedTokenETH,
  reserveSelectedTokenToken
) {
  // eth to token - buy
  if (inputTokenSymbol === TOKEN_SYMBOLS.ETH && outputTokenSymbol === TOKEN_SYMBOLS.SOCKS) {
    const amount = calculateEtherTokenInputFromOutput(SOCKSAmount, reserveSOCKSETH, reserveSOCKSToken)
    if (amount.lte(ethers.constants.Zero) || amount.gte(ethers.constants.MaxUint256)) {
      throw Error()
    }
    return amount
  }

  // token to eth - sell
  if (inputTokenSymbol === TOKEN_SYMBOLS.SOCKS && outputTokenSymbol === TOKEN_SYMBOLS.ETH) {
    const amount = calculateEtherTokenOutputFromInput(SOCKSAmount, reserveSOCKSToken, reserveSOCKSETH)
    if (amount.lte(ethers.constants.Zero) || amount.gte(ethers.constants.MaxUint256)) {
      throw Error()
    }

    return amount
  }

  // token to token - buy or sell
  const buyingSOCKS = outputTokenSymbol === TOKEN_SYMBOLS.SOCKS

  if (buyingSOCKS) {
    console.log('hey!')
    // eth needed to buy x socks
    const intermediateValue = calculateEtherTokenInputFromOutput(SOCKSAmount, reserveSOCKSETH, reserveSOCKSToken)
    // calculateEtherTokenOutputFromInput
    if (intermediateValue.lte(ethers.constants.Zero) || intermediateValue.gte(ethers.constants.MaxUint256)) {
      throw Error()
    }
    // tokens needed to buy x eth
    const amount = calculateEtherTokenInputFromOutput(
      intermediateValue,
      reserveSelectedTokenToken,
      reserveSelectedTokenETH
    )
    console.log(amountFormatter(amount, 18, 4))
    if (amount.lte(ethers.constants.Zero) || amount.gte(ethers.constants.MaxUint256)) {
      throw Error()
    }
    return amount
  } else {
    // eth gained from selling x socks
    const intermediateValue = calculateEtherTokenOutputFromInput(SOCKSAmount, reserveSOCKSToken, reserveSOCKSETH)
    if (intermediateValue.lte(ethers.constants.Zero) || intermediateValue.gte(ethers.constants.MaxUint256)) {
      throw Error()
    }
    // tokens yielded from selling x eth
    const amount = calculateEtherTokenOutputFromInput(
      intermediateValue,
      reserveSelectedTokenETH,
      reserveSelectedTokenToken
    )
    if (amount.lte(ethers.constants.Zero) || amount.gte(ethers.constants.MaxUint256)) {
      throw Error()
    }
    return amount
  }
}

export default function Main() {
  const { account } = useWeb3Context()

  // selected token
  const [selectedTokenSymbol, setSelectedTokenSymbol] = useState(TOKEN_SYMBOLS.ETH)

  // get exchange contracts
  const exchangeContractSOCKS = useExchangeContract(TOKEN_ADDRESSES.SOCKS)
  const exchangeContractSelectedToken = useExchangeContract(TOKEN_ADDRESSES[selectedTokenSymbol])
  const exchangeContractDAI = useExchangeContract(TOKEN_ADDRESSES.DAI)

  // get token contracts
  const tokenContractSOCKS = useTokenContract(TOKEN_ADDRESSES.SOCKS)
  const tokenContractSelectedToken = useTokenContract(TOKEN_ADDRESSES[selectedTokenSymbol])

  // get balances
  const balanceETH = useAddressBalance(account, TOKEN_ADDRESSES.ETH)
  const balanceSOCKS = useAddressBalance(account, TOKEN_ADDRESSES.SOCKS)
  const balanceSelectedToken = useAddressBalance(account, TOKEN_ADDRESSES[selectedTokenSymbol])

  // get allowances
  const allowanceSOCKS = useAddressAllowance(
    account,
    TOKEN_ADDRESSES.SOCKS,
    exchangeContractSOCKS && exchangeContractSOCKS.address
  )
  const allowanceSelectedToken = useAddressAllowance(
    account,
    TOKEN_ADDRESSES[selectedTokenSymbol],
    exchangeContractSelectedToken && exchangeContractSelectedToken.address
  )

  // get reserves
  const reserveSOCKSETH = useAddressBalance(exchangeContractSOCKS && exchangeContractSOCKS.address, TOKEN_ADDRESSES.ETH)
  const reserveSOCKSToken = useAddressBalance(
    exchangeContractSOCKS && exchangeContractSOCKS.address,
    TOKEN_ADDRESSES.SOCKS
  )
  const reserveSelectedTokenETH = useAddressBalance(
    exchangeContractSelectedToken && exchangeContractSelectedToken.address,
    TOKEN_ADDRESSES.ETH
  )
  const reserveSelectedTokenToken = useAddressBalance(
    exchangeContractSelectedToken && exchangeContractSelectedToken.address,
    TOKEN_ADDRESSES[selectedTokenSymbol]
  )
  const reserveDAIETH = useAddressBalance(exchangeContractDAI && exchangeContractDAI.address, TOKEN_ADDRESSES.ETH)
  const reserveDAIToken = useAddressBalance(exchangeContractDAI && exchangeContractDAI.address, TOKEN_ADDRESSES.DAI)

  const [USDExchangeRate, setUSDExchangeRate] = useState()
  useEffect(() => {
    try {
      const exchangeRateDAI = getExchangeRate(reserveDAIETH, reserveDAIToken)

      if (selectedTokenSymbol === TOKEN_SYMBOLS.ETH) {
        setUSDExchangeRate(exchangeRateDAI)
      } else {
        const exchangeRateSelectedToken = getExchangeRate(reserveSelectedTokenETH, reserveSelectedTokenToken)
        if (exchangeRateDAI && exchangeRateSelectedToken) {
          setUSDExchangeRate(
            exchangeRateDAI
              .mul(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(18)))
              .div(exchangeRateSelectedToken)
          )
        }
      }
    } catch {
      setUSDExchangeRate()
    }
  }, [reserveDAIETH, reserveDAIToken, reserveSelectedTokenETH, reserveSelectedTokenToken, selectedTokenSymbol])

  function dollarize(amount) {
    return amount.mul(USDExchangeRate).div(ethers.utils.bigNumberify(10).pow(ethers.utils.bigNumberify(18)))
  }

  const ready =
    selectedTokenSymbol &&
    reserveSOCKSETH &&
    reserveSOCKSToken &&
    (selectedTokenSymbol === 'ETH' || reserveSelectedTokenETH) &&
    (selectedTokenSymbol === 'ETH' || reserveSelectedTokenToken) &&
    (selectedTokenSymbol === 'ETH' || allowanceSelectedToken) &&
    allowanceSOCKS &&
    balanceETH &&
    balanceSOCKS &&
    balanceSelectedToken &&
    tokenContractSOCKS &&
    (selectedTokenSymbol === 'ETH' || tokenContractSelectedToken) &&
    exchangeContractSOCKS &&
    (selectedTokenSymbol === 'ETH' || exchangeContractSelectedToken) &&
    USDExchangeRate

  async function unlock(buyingSOCKS = true) {
    const contract = buyingSOCKS ? tokenContractSelectedToken : tokenContractSOCKS
    const spenderAddress = buyingSOCKS ? exchangeContractSelectedToken.address : exchangeContractSOCKS.address

    const estimatedGasLimit = await contract.estimate.approve(spenderAddress, ethers.constants.MaxUint256)

    return contract
      .approve(spenderAddress, ethers.constants.MaxUint256, {
        gasLimit: calculateGasMargin(estimatedGasLimit, GAS_MARGIN)
      })
      .then(({ hash }) => hash)
  }

  // buy functionality
  const validateBuy = useCallback(
    numberOfSOCKS => {
      // validate passed amount
      let parsedValue
      try {
        parsedValue = ethers.utils.parseUnits(numberOfSOCKS, 18)
      } catch (error) {
        error.code = ERROR_CODES.INVALID_AMOUNT
        throw error
      }

      let requiredValueInSelectedToken
      try {
        requiredValueInSelectedToken = calculateAmount(
          selectedTokenSymbol,
          TOKEN_SYMBOLS.SOCKS,
          parsedValue,
          reserveSOCKSETH,
          reserveSOCKSToken,
          reserveSelectedTokenETH,
          reserveSelectedTokenToken
        )
      } catch (error) {
        error.code = ERROR_CODES.INVALID_EXCHANGE
        throw error
      }

      // get max slippage amount
      const { maximum } = calculateSlippageBounds(requiredValueInSelectedToken)

      // validate minimum ether balance
      if (balanceETH.lt(ethers.utils.parseEther('.01'))) {
        const error = Error()
        error.code = ERROR_CODES.INSUFFICIENT_ETH_BALANCE
        throw error
      }

      // validate minimum selected token balance
      if (balanceSelectedToken.lt(maximum)) {
        const error = Error()
        error.code = ERROR_CODES.INSUFFICIENT_TOKEN_BALANCE
        throw error
      }

      // validate allowance
      if (selectedTokenSymbol !== 'ETH') {
        if (allowanceSelectedToken.lt(maximum)) {
          const error = Error()
          error.code = ERROR_CODES.INSUFFICIENT_ALLOWANCE
          throw error
        }
      }

      return { inputValue: requiredValueInSelectedToken, maximumInputValue: maximum, outputValue: parsedValue }
    },
    [
      allowanceSelectedToken,
      balanceETH,
      balanceSelectedToken,
      reserveSOCKSETH,
      reserveSOCKSToken,
      reserveSelectedTokenETH,
      reserveSelectedTokenToken,
      selectedTokenSymbol
    ]
  )

  async function buy(maximumInputValue, outputValue) {
    const deadline = Math.ceil(Date.now() / 1000) + DEADLINE_FROM_NOW

    if (selectedTokenSymbol === TOKEN_SYMBOLS.ETH) {
      const estimatedGasLimit = await exchangeContractSOCKS.estimate.ethToTokenSwapOutput(outputValue, deadline, {
        value: maximumInputValue
      })
      return exchangeContractSOCKS
        .ethToTokenSwapOutput(outputValue, deadline, {
          value: maximumInputValue,
          gasLimit: calculateGasMargin(estimatedGasLimit, GAS_MARGIN)
        })
        .then(({ hash }) => hash)
    } else {
      console.log(amountFormatter(maximumInputValue, 18, 2))
      console.log(amountFormatter(outputValue, 18, 2))
      const estimatedGasLimit = await exchangeContractSelectedToken.estimate.tokenToTokenSwapOutput(
        outputValue,
        maximumInputValue,
        ethers.constants.MaxUint256,
        deadline,
        TOKEN_ADDRESSES.SOCKS
      )
      return exchangeContractSelectedToken
        .tokenToTokenSwapOutput(
          outputValue,
          maximumInputValue,
          ethers.constants.MaxUint256,
          deadline,
          TOKEN_ADDRESSES.SOCKS,
          {
            gasLimit: calculateGasMargin(estimatedGasLimit, GAS_MARGIN)
          }
        )
        .then(({ hash }) => hash)
    }
  }

  // sell functionality
  const validateSell = useCallback(
    numberOfSOCKS => {
      // validate passed amount
      let parsedValue
      try {
        parsedValue = ethers.utils.parseUnits(numberOfSOCKS, 18)
      } catch (error) {
        error.code = ERROR_CODES.INVALID_AMOUNT
        throw error
      }

      // how much ETH or tokens the sale will result in
      let requiredValueInSelectedToken
      try {
        requiredValueInSelectedToken = calculateAmount(
          TOKEN_SYMBOLS.SOCKS,
          selectedTokenSymbol,
          parsedValue,
          reserveSOCKSETH,
          reserveSOCKSToken,
          reserveSelectedTokenETH,
          reserveSelectedTokenToken
        )
      } catch (error) {
        error.code = ERROR_CODES.INVALID_EXCHANGE
        throw error
      }

      // slippage-ized
      const { minimum } = calculateSlippageBounds(requiredValueInSelectedToken)

      // validate minimum ether balance
      if (balanceETH.lt(ethers.utils.parseEther('.01'))) {
        const error = Error()
        error.code = ERROR_CODES.INSUFFICIENT_ETH_BALANCE
        throw error
      }

      // validate minimum socks balance
      if (balanceSOCKS.lt(parsedValue)) {
        const error = Error()
        error.code = ERROR_CODES.INSUFFICIENT_TOKEN_BALANCE
        throw error
      }

      // validate allowance
      if (allowanceSOCKS.lt(parsedValue)) {
        const error = Error()
        error.code = ERROR_CODES.INSUFFICIENT_ALLOWANCE
        throw error
      }

      return { inputValue: parsedValue, outputValue: requiredValueInSelectedToken, minimumOutputValue: minimum }
    },
    [
      allowanceSOCKS,
      balanceETH,
      balanceSOCKS,
      reserveSOCKSETH,
      reserveSOCKSToken,
      reserveSelectedTokenETH,
      reserveSelectedTokenToken,
      selectedTokenSymbol
    ]
  )

  async function sell(inputValue, minimumOutputValue) {
    const deadline = Math.ceil(Date.now() / 1000) + DEADLINE_FROM_NOW

    if (selectedTokenSymbol === TOKEN_SYMBOLS.ETH) {
      const estimatedGasLimit = await exchangeContractSOCKS.estimate.tokenToEthSwapInput(
        inputValue,
        minimumOutputValue,
        deadline
      )
      return exchangeContractSOCKS
        .tokenToEthSwapInput(inputValue, minimumOutputValue, deadline, {
          gasLimit: calculateGasMargin(estimatedGasLimit, GAS_MARGIN)
        })
        .then(({ hash }) => hash)
    } else {
      const estimatedGasLimit = await exchangeContractSOCKS.estimate.tokenToTokenSwapInput(
        inputValue,
        minimumOutputValue,
        ethers.constants.One,
        deadline,
        TOKEN_ADDRESSES[selectedTokenSymbol]
      )
      return exchangeContractSOCKS
        .tokenToTokenSwapInput(
          inputValue,
          minimumOutputValue,
          ethers.constants.One,
          deadline,
          TOKEN_ADDRESSES[selectedTokenSymbol],
          {
            gasLimit: calculateGasMargin(estimatedGasLimit, GAS_MARGIN)
          }
        )
        .then(({ hash }) => hash)
    }
  }

  return (
    <Body
      selectedTokenSymbol={selectedTokenSymbol}
      setSelectedTokenSymbol={setSelectedTokenSymbol}
      ready={ready}
      unlock={unlock}
      validateBuy={validateBuy}
      buy={buy}
      validateSell={validateSell}
      sell={sell}
      dollarize={dollarize}
    />
  )
}