import {
  Address,
  BigNum,
  Bip32PrivateKey, hash_transaction,
  LinearFee, make_vkey_witness, Transaction, TransactionBody,
  TransactionBuilder, TransactionHash, TransactionInput, TransactionOutput, TransactionWitnessSet, Value, Vkeywitnesses,
} from '@emurgo/cardano-serialization-lib-nodejs';
import BigNumber from 'bignumber.js'
import { adaBroadcast, adaGetBlockChainInfo, adaGetTransaction, adaGetUtxos } from '../blockchain/ada'
import { validateBody } from '../connector/tatum';
import { AdaUtxo, Currency, FromAddress, FromUTXO, To, TransactionKMS, TransferBtcBasedBlockchain } from '../model';

/**
 * Prepare a signed Ada transaction with the private key locally. Nothing is broadcasted to the blockchain.
 * @param transferBtcBasedBlockchain content of the transaction to prepare.
 * @returns raw transaction data in hex, to be broadcasted to blockchain.
 */
export const prepareAdaTransaction = async (transferBtcBasedBlockchain: TransferBtcBasedBlockchain) => {
  await validateBody(transferBtcBasedBlockchain, TransferBtcBasedBlockchain);
  const txBuilder = await initTransactionBuilder()
  const { to } = transferBtcBasedBlockchain

  const { privateKeysToSign, amount: fromAmount } = await addInputs(txBuilder, transferBtcBasedBlockchain)
  const toAmount = addOutputs(txBuilder, to)
  await processFeeAndRest(txBuilder, fromAmount, toAmount, transferBtcBasedBlockchain)

  return signTransaction(txBuilder, transferBtcBasedBlockchain, privateKeysToSign)
};

/**
 * Send Ada transaction to the blockchain. This method broadcasts signed transaction to the blockchain.
 * This operation is irreversible.
 * @param body content of the transaction to broadcast
 * @returns transaction id of the transaction in the blockchain
 */
export const sendAdaTransaction = async (body: TransferBtcBasedBlockchain) => {
  return adaBroadcast(await prepareAdaTransaction(body))
}

/**
 * Sign Ada pending transaction from Tatum KMS
 * @param tx pending transaction from KMS
 * @param privateKeys private keys to sign transaction with.
 * @returns transaction data to be broadcast to blockchain.
 */
export const signAdaKMSTransaction = async (tx: TransactionKMS, privateKeys: string[]) => {
  if (tx.chain !== Currency.ADA) {
    throw Error('Unsupported chain.');
  }
  const transactionBody = TransactionBody.from_bytes(Uint8Array.from(Array.from(tx.serializedTransaction).map(Number)))
  const txHash = hash_transaction(transactionBody);
  const vKeyWitnesses = Vkeywitnesses.new();
  for (const privateKey of privateKeys) {
    makeWitness(privateKey, txHash, vKeyWitnesses)
  }
  const witnesses = TransactionWitnessSet.new();
  witnesses.set_vkeys(vKeyWitnesses);
  return Buffer.from(
    Transaction.new(transactionBody, witnesses).to_bytes(),
  ).toString('hex')
};

const addOutputs = (transactionBuilder: TransactionBuilder, tos: To[]) => {
  let amount = new BigNumber(0)
  for (const to of tos) {
    const value = new BigNumber(1000000).times(to.value)
    amount = value.plus(amount)
    addOutput(transactionBuilder, to.address, value.toString())
  }
  return amount
}

const addInputs = async (transactionBuilder: TransactionBuilder, transferBtcBasedBlockchain: TransferBtcBasedBlockchain) => {
  const { fromUTXO, fromAddress } = transferBtcBasedBlockchain
  if (fromAddress) {
    return addAddressInputs(transactionBuilder, fromAddress)
  }
  if (fromUTXO) {
    return addUtxoInputs(transactionBuilder, fromUTXO)
  }
  throw new Error('Field fromAddress or fromUTXO is not filled.')
}

const addAddressInputs = async (transactionBuilder: TransactionBuilder, fromAddresses: FromAddress[]) => {
  let amount = new BigNumber(0)
  const privateKeysToSign: string[] = [];
  for (const fromAddress of fromAddresses) {
    const { address, privateKey } = fromAddress
    const utxos: AdaUtxo[] = await adaGetUtxos(address)
    for (const utxo of utxos) {
      amount = amount.plus(utxo.value);
      addInput(transactionBuilder, privateKey, utxo, address)
      privateKeysToSign.push(fromAddress.signatureId || fromAddress.privateKey)
    }
  }
  return { amount, privateKeysToSign }
}

const addUtxoInputs = async (transactionBuilder: TransactionBuilder, fromUTXOs: FromUTXO[]) => {
  let amount = new BigNumber(0)
  const privateKeysToSign: string[] = [];
  for (const utxo of fromUTXOs) {
    const transaction = await adaGetTransaction(utxo.txHash)
    const output = transaction.outputs.find(output => output.index === utxo.index)
    if (output) {
      const value = output.value;
      amount = amount.plus(value);
      addInput(transactionBuilder, utxo.privateKey, { value, ...utxo }, output.address)
      privateKeysToSign.push(utxo.signatureId || utxo.privateKey)
    }
  }
  return { amount, privateKeysToSign }
}

const addOutput = (transactionBuilder: TransactionBuilder, address: string, amount: string) => {
  transactionBuilder.add_output(TransactionOutput.new(
    Address.from_bech32(address),
    Value.new(BigNum.from_str(amount)),
  ));
}

const addInput = (transactionBuilder: TransactionBuilder, privateKey: string, utxo: AdaUtxo, address: string) => {
  transactionBuilder.add_input(
    Address.from_bech32(address),
    TransactionInput.new(
      TransactionHash.from_bytes(Buffer.from(utxo.txHash, 'hex')),
      utxo.index,
    ),
    Value.new(BigNum.from_str(utxo.value)),
  )
}

const initTransactionBuilder = async () => {
  const txBuilder = TransactionBuilder.new(
    LinearFee.new(
      BigNum.from_str('44'),
      BigNum.from_str('155381'),
    ),
    BigNum.from_str('1000000'),
    BigNum.from_str('500000000'),
    BigNum.from_str('2000000'),
  );
  const { tip: { slotNo } } = await adaGetBlockChainInfo();
  txBuilder.set_ttl(slotNo + 200);
  return txBuilder
}

const createWitnesses = (transactionBody: TransactionBody, transferBtcBasedBlockchain: TransferBtcBasedBlockchain) => {
  const { fromAddress, fromUTXO } = transferBtcBasedBlockchain
  const txHash = hash_transaction(transactionBody);
  const vKeyWitnesses = Vkeywitnesses.new();
  if (fromAddress) {
    for (const address of fromAddress) {
      makeWitness(address.privateKey, txHash, vKeyWitnesses)
    }
  } else if (fromUTXO) {
    for (const utxo of fromUTXO) {
      makeWitness(utxo.privateKey, txHash, vKeyWitnesses)
    }
  } else {
    throw new Error('No private key for witness found.')
  }
  const witnesses = TransactionWitnessSet.new();
  witnesses.set_vkeys(vKeyWitnesses);
  return witnesses
}

const makeWitness = (privateKey: string, txHash: TransactionHash, vKeyWitnesses: Vkeywitnesses) => {
  const privateKeyCardano = Bip32PrivateKey.from_128_xprv(
    Buffer.from(privateKey, 'hex'),
  ).to_raw_key();
  vKeyWitnesses.add(make_vkey_witness(txHash, privateKeyCardano));
}

const processFeeAndRest = async (transactionBuilder: TransactionBuilder, fromAmount: BigNumber, toAmount: BigNumber, transferBtcBasedBlockchain: TransferBtcBasedBlockchain) => {
  const { fromAddress, fromUTXO } = transferBtcBasedBlockchain
  if (fromAddress) {
    addFeeAndRest(transactionBuilder, fromAddress[0].address, fromAmount, toAmount)
  } else if (fromUTXO) {
    const txHash = fromUTXO[0].txHash
    const transaction = await adaGetTransaction(txHash)
    const output = transaction.outputs.find(output => output.index === fromUTXO[0].index)
    if (output) {
      addFeeAndRest(transactionBuilder, output.address, fromAmount, toAmount)
    }
  } else {
    throw new Error('Field fromAddress or fromUTXO is not filled.')
  }
}

const addFeeAndRest = (transactionBuilder: TransactionBuilder, address: string, fromAmount: BigNumber, toAmount: BigNumber) => {
  const fromRest = Address.from_bech32(address);
  const tmpOutput = TransactionOutput.new(
    fromRest,
    Value.new(BigNum.from_str(String('1000000'))),
  );
  const fee = parseInt(transactionBuilder.min_fee().to_str()) + parseInt(transactionBuilder.fee_for_output(tmpOutput).to_str());
  addOutput(transactionBuilder, address, fromAmount.minus(toAmount).minus(fee).toString())
  transactionBuilder.set_fee(BigNum.from_str(String(fee)));
}

const signTransaction = (transactionBuilder: TransactionBuilder, transferBtcBasedBlockchain: TransferBtcBasedBlockchain, privateKeysToSign: string[]) => {
  const txBody = transactionBuilder.build();
  const { fromAddress, fromUTXO } = transferBtcBasedBlockchain

  if ((fromAddress && fromAddress[0].signatureId) || (fromUTXO && fromUTXO[0].signatureId)) {
    return JSON.stringify({ txData: JSON.stringify(txBody.to_bytes()), privateKeysToSign });
  }

  const witnesses = createWitnesses(txBody, transferBtcBasedBlockchain)

  return Buffer.from(
    Transaction.new(txBody, witnesses).to_bytes(),
  ).toString('hex')
}