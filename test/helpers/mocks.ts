// Placeholder for mock VTab modules and helpers
import type { Database } from '../../src/core/database.js';
import type { TableSchema } from '../../src/schema/table.js';
import { type VirtualTableModule, VirtualTable } from '../../src/index.js';
import type { IndexInfo, IndexConstraint } from '../../src/vtab/indexInfo.js';
import { StatusCode, type SqlValue } from '../../src/common/types.js';

// Define BestIndexResult based on IndexInfo fields used
interface BestIndexResult {
    idxNum?: number;
    idxStr?: string | null;
    orderByConsumed?: boolean;
    estimatedCost?: number;
    estimatedRows?: bigint;
    idxFlags?: number;
    // Include aConstraintUsage if needed
}

// --- Mock VirtualTable Implementation ---
class MockVirtualTable extends VirtualTable {
    constructor(db: Database, module: VirtualTableModule<any, any>, schemaName: string, tableName: string, public tableSchemaProvided?: TableSchema) {
        super(db, module, schemaName, tableName);
        this.tableSchema = tableSchemaProvided;
    }

    async xDisconnect(): Promise<void> {}
    // Stub xOpen as it shouldn't be called during planning tests
    async xOpen(): Promise<any> { // Return type any to avoid cursor complexity
        throw new Error('MockVirtualTable.xOpen should not be called in planner tests');
    }
    async xUpdate(values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint | undefined; }> {
        return {};
    }
}
// --- End Mock VirtualTable ---

/**
 * Basic mock VTab module for testing planner interactions.
 */
export class MockVtabModule implements VirtualTableModule<any, any> {
    bestIndexResult: Partial<BestIndexResult> = {};
    constrainedBestIndexResult: Partial<BestIndexResult> | null = null;
    xBestIndexCalls: IndexInfo[] = [];

    xConnect = (db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: any): VirtualTable => {
        return new MockVirtualTable(db, this, schemaName, tableName);
    };
    xDisconnect = () => { return StatusCode.OK; };
    xDestroy = async () => { /* No-op */ };

    xCreate = (db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: any) => {
        return StatusCode.OK;
    };

    xBestIndex = (db: Database, table: TableSchema, indexInfo: IndexInfo): number => {
        this.xBestIndexCalls.push(structuredClone(indexInfo));

        let resultToApply = this.bestIndexResult;
        if (indexInfo.nConstraint > 0 && this.constrainedBestIndexResult) {
            console.log(`MockVtab [${table.name}]: Applying CONSTRAINED bestIndexResult (nConstraint=${indexInfo.nConstraint})`);
            resultToApply = this.constrainedBestIndexResult;
        } else {
            console.log(`MockVtab [${table.name}]: Applying BASE bestIndexResult (nConstraint=${indexInfo.nConstraint})`);
        }

        if (resultToApply.idxNum !== undefined) indexInfo.idxNum = resultToApply.idxNum;
        if (resultToApply.idxStr !== undefined) indexInfo.idxStr = resultToApply.idxStr;
        if (resultToApply.orderByConsumed !== undefined) indexInfo.orderByConsumed = resultToApply.orderByConsumed;
        if (resultToApply.estimatedCost !== undefined) indexInfo.estimatedCost = resultToApply.estimatedCost;
        if (resultToApply.estimatedRows !== undefined) indexInfo.estimatedRows = resultToApply.estimatedRows;
        if (resultToApply.idxFlags !== undefined) indexInfo.idxFlags = resultToApply.idxFlags;
        return StatusCode.OK;
    };
}

interface MockTableOptions {
    schema: Omit<TableSchema, 'vtabModule' | 'vtabModuleName'>;
    bestIndexResult?: Partial<BestIndexResult>;
    constrainedBestIndexResult?: Partial<BestIndexResult>;
}

/**
 * Helper to register a mock table with the test database.
 */
export function mockTable(db: Database, options: MockTableOptions): MockVtabModule {
    const module = new MockVtabModule();
    if (options.bestIndexResult) {
        module.bestIndexResult = options.bestIndexResult;
    }
    if (options.constrainedBestIndexResult) {
        module.constrainedBestIndexResult = options.constrainedBestIndexResult;
    }

    const fullSchema: TableSchema = {
        ...options.schema,
        vtabModule: module,
        vtabModuleName: options.schema.name,
        isTemporary: options.schema.isTemporary ?? false,
        isView: options.schema.isView ?? false,
        isStrict: options.schema.isStrict ?? false,
        isWithoutRowid: options.schema.isWithoutRowid ?? true,
        schemaName: options.schema.schemaName ?? 'main',
        primaryKeyDefinition: options.schema.primaryKeyDefinition ?? [],
        checkConstraints: options.schema.checkConstraints ?? [],
    };

    try {
        // Register the module instance directly (simpler for testing)
        // @ts-ignore - Accessing private property for testing
        db.registeredVTabs.set(fullSchema.vtabModuleName.toLowerCase(), { module, auxData: undefined }); // Use registeredVTabs and correct structure

        // Add schema to catalog (simpler than parsing CREATE VIRTUAL TABLE)
        // @ts-ignore - Accessing private property for testing
        db.schemaManager.getMainSchema().addTable(fullSchema); // Use schemaManager to add table

    } catch (e) {
        console.error("Failed to register mock table:", e);
        throw e;
    }

    return module;
}
