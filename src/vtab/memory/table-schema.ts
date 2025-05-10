import { SqliterError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { ColumnDef } from '../../parser/index.js';
import { getAffinity } from '../../schema/column.js';
import { columnDefToSchema, buildColumnIndexMap } from '../../schema/table.js';
import { Latches } from '../../util/latches.js';
import type { SchemaChangeInfo } from '../module.js';

// Removed addColumnLogic, dropColumnLogic, renameColumnLogic,
// xRenameLogic, and xAlterSchemaLogic functions as they contained
// outdated logic conflicting with the new MemoryTableManager/Connection architecture.
// The actual implementation is now handled by MemoryTable delegating to MemoryTableManager.

