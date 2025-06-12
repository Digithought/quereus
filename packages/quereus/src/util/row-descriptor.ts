import type { RowDescriptor, Attribute } from '../planner/nodes/plan-node.js';

/**
 * Utility to build a RowDescriptor (attributeId → columnIndex mapping)
 * for any relational plan node.
 */
export function buildRowDescriptor(attributes: Attribute[]): RowDescriptor {
  const descriptor: RowDescriptor = [];
  attributes.forEach((attr, index) => {
    descriptor[attr.id] = index;
  });
  return descriptor;
}
