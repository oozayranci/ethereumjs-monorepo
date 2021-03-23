import { Address, BN, toBuffer } from 'ethereumjs-util'
import { encode } from 'rlp'
import { BaseTrie as Trie } from 'merkle-patricia-tree'
import { TypedTransaction } from '@ethereumjs/tx'
import { Block, BlockOptions, HeaderData } from '@ethereumjs/block'
import VM from '.'
import { RunTxResult } from './runTx'
import Bloom from './bloom'
import { generateTxReceipt, calculateMinerReward, rewardAccount } from './runBlock'

/**
 * Options for building a block.
 */
export interface BuildBlockOpts {
  /**
   * The parent block
   */
  parentBlock: Block

  /**
   * The block header data to use.
   * Defaults used for any values not provided.
   */
  headerData?: HeaderData

  /**
   * The block options to use.
   */
  blockOpts?: BlockOptions
}

/**
 * Options for sealing a block.
 */
export interface SealBlockOpts {
  /**
   * For PoW, the nonce.
   * Overrides the value passed in the constructor.
   */
  nonce?: Buffer

  /**
   * For PoW, the mixHash.
   * Overrides the value passed in the constructor.
   */
  mixHash?: Buffer
}

export class BlockBuilder {
  private readonly vm: VM
  private blockOpts: BlockOptions
  private headerData: HeaderData
  private transactions: TypedTransaction[] = []
  private transactionResults: RunTxResult[] = []
  private checkpointed = false
  private reverted = false
  private built = false

  constructor(vm: VM, opts: BuildBlockOpts) {
    this.vm = vm
    this.blockOpts = { ...opts.blockOpts, common: this.vm._common }

    this.headerData = {
      ...opts.headerData,
      parentHash: opts.headerData?.parentHash ?? opts.parentBlock.hash(),
      number: opts.headerData?.number ?? opts.parentBlock.header.number.addn(1),
      gasLimit: opts.headerData?.gasLimit ?? opts.parentBlock.header.gasLimit,
    }
  }

  /**
   * Throws if the block has already been built or reverted.
   */
  checkStatus() {
    if (this.built) {
      throw new Error('Block has already been built')
    }
    if (this.reverted) {
      throw new Error('State has already been reverted')
    }
  }

  /**
   * Returns the cumulative gas used by the transactions added to the block.
   */
  gasUsed(): BN {
    return this.transactionResults.reduce(
      (accumulator: BN, result: RunTxResult) => accumulator.iadd(result.gasUsed),
      new BN(0)
    )
  }

  /**
   * Calculates and returns the transactionsTrie for the block.
   */
  private async transactionsTrie() {
    const trie = new Trie()
    for (const [i, tx] of this.transactions.entries()) {
      await trie.put(encode(i), tx.serialize())
    }
    return trie.root
  }

  /**
   * Calculates and returns the logs bloom for the block.
   */
  private bloom() {
    const bloom = new Bloom()
    for (const txResult of this.transactionResults) {
      // Combine blooms via bitwise OR
      bloom.or(txResult.bloom)
    }
    return bloom.bitvector
  }

  /**
   * Calculates and returns the receiptTrie for the block.
   */
  private async receiptTrie() {
    const gasUsed = new BN(0)
    const receiptTrie = new Trie()
    for (const [i, txResult] of this.transactionResults.entries()) {
      const tx = this.transactions[i]
      gasUsed.iadd(txResult.gasUsed)
      const { encodedReceipt } = await generateTxReceipt.bind(this.vm)(tx, txResult, gasUsed)
      await receiptTrie.put(encode(i), encodedReceipt)
    }
    return receiptTrie.root
  }

  /**
   * Adds the block miner reward to the coinbase account.
   */
  private async rewardMiner() {
    const minerReward = new BN(this.vm._common.param('pow', 'minerReward'))
    const reward = calculateMinerReward(minerReward, 0)
    const coinbase = this.headerData.coinbase
      ? new Address(toBuffer(this.headerData.coinbase))
      : Address.zero()
    await rewardAccount(this.vm.stateManager, coinbase, reward)
  }

  /**
   * Run and add a transaction to the block being built.
   * Please note that this modifies the state of the VM.
   * Throws if the transaction's gasLimit is greater than
   * the remaining gas in the block.
   */
  async addTransaction(tx: TypedTransaction) {
    this.checkStatus()

    if (!this.checkpointed) {
      await this.vm.stateManager.checkpoint()
      this.checkpointed = true
    }

    // According to the Yellow Paper, a transaction's gas limit
    // cannot be greater than the remaining gas in the block
    const blockGasLimit = new BN(toBuffer(this.headerData.gasLimit))
    const blockGasRemaining = blockGasLimit.sub(this.gasUsed())
    if (tx.gasLimit.gt(blockGasRemaining)) {
      throw new Error('tx has a higher gas limit than the remaining gas in the block')
    }

    const blockData = { header: this.headerData, transactions: this.transactions }
    const block = Block.fromBlockData(blockData, this.blockOpts)

    const result = await this.vm.runTx({ tx, block })

    this.transactions.push(tx)
    this.transactionResults.push(result)

    return result
  }

  /**
   * Reverts the checkpoint on the StateManager to reset the state from any transactions that have been run.
   */
  async revert() {
    this.checkStatus()
    if (this.checkpointed) {
      await this.vm.stateManager.revert()
      this.reverted = true
    }
  }

  /**
   * This method returns the finalized block.
   * It also:
   *  - Assigns the reward for miner (PoW)
   *  - Commits the checkpoint on the StateManager
   *  - Sets the tip of the VM's blockchain to this block
   * For PoW, optionally seals the block with params `nonce` and `mixHash`,
   * which is validated along with the block number and difficulty by ethash.
   * For PoA, please pass `blockOption.cliqueSigner` into the buildBlock constructor,
   * as the signer will be awarded the txs amount spent on gas as they are added.
   */
  async build(sealOpts?: SealBlockOpts) {
    this.checkStatus()
    const blockOpts = this.blockOpts
    const consensusType = this.vm._common.consensusType()

    if (consensusType === 'pow') {
      await this.rewardMiner()
    }

    await this.vm.stateManager.commit()

    const stateRoot = await this.vm.stateManager.getStateRoot(false)
    const transactionsTrie = await this.transactionsTrie()
    const receiptTrie = await this.receiptTrie()
    const bloom = this.bloom()
    const gasUsed = this.gasUsed()
    const timestamp = this.headerData.timestamp ?? Math.round(Date.now() / 1000)

    const headerData = {
      ...this.headerData,
      stateRoot,
      transactionsTrie,
      receiptTrie,
      bloom,
      gasUsed,
      timestamp,
    }

    if (consensusType === 'pow') {
      headerData.nonce = sealOpts?.nonce ?? headerData.nonce
      headerData.mixHash = sealOpts?.mixHash ?? headerData.mixHash
    }

    const blockData = { header: headerData, transactions: this.transactions }
    const block = Block.fromBlockData(blockData, blockOpts)
    await this.vm.blockchain.putBlock(block)
    this.built = true
    return block
  }
}

export default async function buildBlock(this: VM, opts: BuildBlockOpts): Promise<BlockBuilder> {
  return new BlockBuilder(this, opts)
}