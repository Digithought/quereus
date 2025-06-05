export enum PlanNodeType {
  // Logical Nodes (from builder)
  Block = 'Block',
  TableReference = 'TableReference',
  TableScan = 'TableScan',
  TableSeek = 'TableSeek',
  Filter = 'Filter',
  Project = 'Project',
  Distinct = 'Distinct',
  Aggregate = 'Aggregate',
  Window = 'Window',
  Sort = 'Sort',
  LimitOffset = 'LimitOffset',
  Join = 'Join',
  SetOperation = 'SetOperation',
  CTE = 'CTE',
  RecursiveCTE = 'RecursiveCTE',
  In = 'In',
  Exists = 'Exists',
  Sequencing = 'Sequencing',

  // DML/DDL Nodes
  Insert = 'Insert',
  Update = 'Update',
  UpdateExecutor = 'UpdateExecutor',
  Delete = 'Delete',
  ConstraintCheck = 'ConstraintCheck',
  CreateTable = 'CreateTable',
  DropTable = 'DropTable',
  CreateIndex = 'CreateIndex',
  DropIndex = 'DropIndex',
  CreateView = 'CreateView',
  DropView = 'DropView',
  AlterTable = 'AlterTable',
  AddConstraint = 'AddConstraint',

  // Physical Nodes (from optimizer)
  SeqScan = 'SeqScan',              // Physical sequential scan
  IndexScan = 'IndexScan',          // Physical index scan
  IndexSeek = 'IndexSeek',          // Physical index seek
  StreamAggregate = 'StreamAggregate',  // Physical ordered aggregate
  HashAggregate = 'HashAggregate',      // Physical hash aggregate
  NestedLoopJoin = 'NestedLoopJoin',
  HashJoin = 'HashJoin',
  MergeJoin = 'MergeJoin',
  Materialize = 'Materialize',      // Materialize intermediate results

  // Scalar expression nodes
  Literal = 'Literal',
  ColumnReference = 'ColumnReference',
  ParameterReference = 'ParameterReference',
  UnaryOp = 'UnaryOp',
  BinaryOp = 'BinaryOp',
  CaseExpr = 'CaseExpr',
  Cast = 'Cast',
  Collate = 'Collate',
  ScalarFunctionCall = 'ScalarFunctionCall',
  WindowFunctionCall = 'WindowFunctionCall',
  Between = 'Between',
  IsNull = 'IsNull',
  ScalarSubquery = 'ScalarSubquery',
  TableFunctionReference = 'TableFunctionReference',

  // Special relational nodes
  Values = 'Values',
  SingleRow = 'SingleRow',  // For SELECT without FROM
  TableFunctionCall = 'TableFunctionCall',

  // Transaction control
  Transaction = 'Transaction',
  Savepoint = 'Savepoint',

  // Utility
  Pragma = 'Pragma',

  // Query execution
  Cache = 'Cache',

  // RETURNING support
  Returning = 'Returning',
}
