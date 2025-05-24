export enum PlanNodeType {
  // Relational Nodes (Zero-ary / Leaf)
  TableScan = 'TableScan',
  TableSeek = 'TableSeek',
  Values = 'Values',

  // Relational Nodes (Unary)
  Filter = 'Filter',
  Project = 'Project',
  Sort = 'Sort',
  Aggregate = 'Aggregate',
  LimitOffset = 'LimitOffset',
  Batch = 'Batch',
	TableFunctionCall = 'TableFunctionCall',
  TableReference = 'TableReference',
	TableFunctionReference = 'TableFunctionReference',

  // Relational Nodes (Binary)
  Join = 'Join',
  // SetOperation (UNION, INTERSECT, EXCEPT) // To be added as needed

  // DDL Nodes
  CreateTable = 'CreateTable',
  DropTable = 'DropTable',

  // DML Nodes (New)
  Insert = 'Insert',
  Update = 'Update',
  Delete = 'Delete',

  // Scalar Nodes (ExpressionNode subtypes)
  Literal = 'Literal',
  ColumnReference = 'ColumnReference',
  ParameterReference = 'ParameterReference',

  UnaryOp = 'UnaryOp',
  BinaryOp = 'BinaryOp',
  ScalarFunctionCall = 'ScalarFunctionCall',
  Cast = 'Cast',
  Collate = 'Collate',
  In = 'In',
  Exists = 'Exists',
  CaseExpr = 'CaseExpr',
}
