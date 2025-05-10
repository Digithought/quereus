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
  Result = 'Result',
	TableFunctionCall = 'TableFunctionCall',
  TableReference = 'TableReference',
	TableFunctionReference = 'TableFunctionReference',

  // Relational Nodes (Binary)
  Join = 'Join',
  // SetOperation (UNION, INTERSECT, EXCEPT) // To be added as needed

  // Scalar Nodes (ExpressionNode subtypes)
  Literal = 'Literal',
  ColumnReference = 'ColumnReference',
  ParameterReference = 'ParameterReference',

  UnaryOp = 'UnaryOp',
  BinaryOp = 'BinaryOp',
  ScalarFunctionCall = 'ScalarFunctionCall',
  Cast = 'Cast',
  Collate = 'Collate',
  Subquery = 'Subquery', // Represents a scalar subquery, IN subquery, or EXISTS subquery
  CaseExpr = 'CaseExpr',
}
