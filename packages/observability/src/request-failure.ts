// Fixed diagnostic vocabulary only. Never retain messages, stacks, URLs,
// provider payloads, query data or arbitrary error fields.
export function requestFailure(error: unknown) {
  const chain: { name?: unknown; code?: unknown; errorLabels?: unknown; cause?: unknown }[] = [];
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const row = current as (typeof chain)[number]; chain.push(row); current = row.cause;
  }
  const hasCode = (code: number) => chain.some(row => row.code === code);
  const named = (name: string) => chain.some(row => row.name === name);
  const reason = hasCode(112) ? 'mongo_write_conflict' : hasCode(24) ? 'mongo_lock_timeout' : hasCode(50) ? 'mongo_execution_timeout' : hasCode(251) ? 'mongo_transaction_aborted' :
    named('MongoOperationTimeoutError') ? 'mongo_operation_timeout' : named('MongoServerSelectionError') ? 'mongo_selection_timeout' :
    named('MongoWaitQueueTimeoutError') ? 'mongo_pool_timeout' : named('MongoPoolClearedError') ? 'mongo_pool_cleared' :
    named('MongoNetworkError') || named('MongoNetworkTimeoutError') ? 'mongo_network' : 'unclassified';
  return { reason, transientTransaction: chain.some(row => Array.isArray(row.errorLabels) && row.errorLabels.includes('TransientTransactionError')),
    ambiguousCommit: chain.some(row => Array.isArray(row.errorLabels) && row.errorLabels.includes('UnknownTransactionCommitResult')) };
}
