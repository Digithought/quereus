/**
 * A unique symbol used within TransactionLayer modification trees
 * to explicitly mark a key (and thus the corresponding row) as deleted
 * within that specific layer.
 */
export const DELETED = Symbol('DELETED');
