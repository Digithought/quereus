// src/vtab/memory/table-logic.ts
import { VirtualTableCursor } from '../cursor.js';
import type { IndexInfo } from '../indexInfo.js';
import { StatusCode } from '../../common/types.js';
import { BTree } from 'digitree';
import { MemoryTableCursor } from './cursor.js';
import { IndexConstraintOp } from '../../common/constants.js';
// Removed MemoryTable import

// Removed all logic functions (xOpenLogic, xBestIndexLogic, xSyncLogic,
// xDisconnectLogic, xDestroyLogic) as they contained obsolete logic or logic
// that belongs in MemoryTableModule or is handled by MemoryTable delegation.
