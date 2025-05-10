// src/vtab/memory/table-mutation.ts
import { SqliterError, ConstraintError } from '../../common/errors.js';
import { type SqlValue, StatusCode } from '../../common/types.js';
import type { MemoryTable } from './table.js';
import type { MemoryTableConnection } from './layer/connection.js';
import { ConflictResolution } from '../../common/constants.js';

// Removed all logic (addRowLogic, updateRowLogic, deleteRowLogic, clearLogic, xUpdateLogic).
// The correct implementation is now handled by MemoryTable.xUpdate delegating
// to MemoryTableManager.performMutation.

