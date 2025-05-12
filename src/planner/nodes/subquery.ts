// Interface for plan nodes representing an IN operation.

import type { PlanNode, ScalarPlanNode } from "./plan-node.js";
import type { ScalarType } from "../../common/datatype.js";
import type { RelationalPlanNode } from "./plan-node.js";
import type { CompareFn } from "../../common/types.js";

// TODO: replace interface with class for InNode
export interface InNode extends PlanNode {
  readonly expression: ScalarPlanNode;     // The expression whose value is checked for membership
  readonly source: RelationalPlanNode;    // The relational source (e.g., a subquery)
  readonly comparator: CompareFn;         // The comparator function to use

  // Required by PlanNode
  getType(): ScalarType; // Typically returns a boolean type
  getChildren(): readonly [ScalarPlanNode]; // The expression is a scalar child
  getRelations(): readonly [RelationalPlanNode]; // The source is a relational child
}