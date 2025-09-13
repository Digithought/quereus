export interface AssertionDependentTable {
  /** Instance-unique table reference key, e.g. schema.table#nodeId */
  relationKey: string;
  /** Base table identifier, e.g. schema.table */
  base: string;
}

export interface IntegrityAssertionSchema {
  /** Unique assertion name */
  name: string;
  /** SQL text of the violation-producing query. Any returned row indicates a violation. */
  violationSql: string;
  /** Whether the assertion is deferrable. Currently always enforced at COMMIT. */
  deferrable: boolean;
  /** If true, initially deferred. Currently informational. */
  initiallyDeferred: boolean;
  /** Base tables referenced; filled during assertion preparation/creation. */
  dependentTables?: AssertionDependentTable[];
}


