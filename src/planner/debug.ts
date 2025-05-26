import type { PlanNode } from './nodes/plan-node.js';
import { safeJsonStringify } from '../util/serialization.js';
import { astToString } from '../util/ast-stringify.js';
import type { Instruction } from '../runtime/types.js';
import type * as AST from '../parser/ast.js';

/**
 * Detailed information about a PlanNode for debugging purposes.
 */
export interface PlanNodeDebugInfo {
  id: string;
  nodeType: string;
  type: any; // The result of getType()
  estimatedCost: number;
  estimatedRows?: number;
  totalCost: number;
  children: PlanNodeDebugInfo[];
  relations: PlanNodeDebugInfo[];
  properties: Record<string, any>; // Node-specific properties
}

/**
 * Information about an instruction in the execution program.
 */
export interface InstructionDebugInfo {
  index: number;
  note?: string;
  paramCount: number;
  paramIndices: number[];
  destination: number | null;
}

/**
 * Checks if a value is an AST node
 */
function isAstNode(value: any): value is AST.AstNode {
	return value && typeof value === 'object' && 'type' in value && typeof value.type === 'string';
}

/**
 * Recursively processes a value, converting AST nodes to SQL strings
 */
function processValue(value: any): any {
	if (value === null || value === undefined) {
		return value;
	}

	// If it's an AST node, convert to SQL string
	if (isAstNode(value)) {
		try {
			return astToString(value);
		} catch (error) {
			return `[AST:${value.type}]`; // Fallback if stringify fails
		}
	}

	// If it's an array, process each element
	if (Array.isArray(value)) {
		return value.map(processValue);
	}

	// If it's an object, process each property
	if (typeof value === 'object') {
		// Skip circular references and complex objects
		if (value.constructor !== Object && value.constructor !== Array) {
			return '[COMPLEX_OBJECT]';
		}

		const processed: Record<string, any> = {};
		for (const [key, val] of Object.entries(value)) {
			try {
				processed[key] = processValue(val);
			} catch {
				processed[key] = '[UNPROCESSABLE]';
			}
		}
		return processed;
	}

	// For primitives, return as-is
	return value;
}

/**
 * Serializes a PlanNode tree to a detailed JSON representation using the existing visit pattern.
 */
export function serializePlanTree(rootNode: PlanNode): string {
	const nodeMap = new Map<PlanNode, PlanNodeDebugInfo>();

	// First pass: collect all nodes using the visit pattern
	rootNode.visit((node) => {
		if (!nodeMap.has(node)) {
			// Get node-specific properties by examining the node object
			const properties: Record<string, any> = {};

			// Extract interesting properties from the node (excluding functions and circular refs)
			for (const [key, value] of Object.entries(node)) {
				if (key === 'scope' || key === 'id' || key === 'nodeType' || key === 'estimatedCost') {
					continue; // Skip these as they're handled separately
				}

				if (typeof value === 'function') {
					continue; // Skip functions
				}

				if (value && typeof value === 'object' && 'nodeType' in value) {
					// This is likely another PlanNode, skip to avoid duplication
					continue;
				}

				try {
					// Process the property value, converting AST nodes to SQL strings
					properties[key] = processValue(value);
				} catch {
					properties[key] = '[UNSERIALIZABLE]';
				}
			}

			nodeMap.set(node, {
				id: node.id,
				nodeType: node.nodeType,
				type: node.getType(),
				estimatedCost: node.estimatedCost,
				estimatedRows: (node as any).estimatedRows,
				totalCost: node.getTotalCost(),
				children: [], // Will be filled in second pass
				relations: [], // Will be filled in second pass
				properties
			});
		}
	});

	// Second pass: establish relationships
	for (const [node, info] of nodeMap) {
		info.children = node.getChildren()
			.map(child => nodeMap.get(child))
			.filter(Boolean) as PlanNodeDebugInfo[];

		info.relations = node.getRelations()
			.map(relation => nodeMap.get(relation))
			.filter(Boolean) as PlanNodeDebugInfo[];
	}

	const rootInfo = nodeMap.get(rootNode);
	if (!rootInfo) {
		throw new Error('Root node not found in serialization map');
	}

	return safeJsonStringify(rootInfo, 2);
}

/**
 * Generates a human-readable program listing of instructions.
 */
export function generateInstructionProgram(
  instructions: readonly Instruction[],
  destinations: readonly (number | null)[]
): string {
  const lines: string[] = [];
  lines.push('=== INSTRUCTION PROGRAM ===');
  lines.push('');

  for (let i = 0; i < instructions.length; i++) {
    const instruction = instructions[i];
    const dest = destinations[i];
    const note = instruction.note ? ` ; ${instruction.note}` : '';
    const destStr = dest !== null ? ` -> [${dest}]` : ' -> [RESULT]';

    lines.push(`[${i.toString().padStart(3)}] PARAMS: [${instruction.params.map((_, idx) =>
      instructions.findIndex(inst => inst === instruction.params[idx])
    ).join(', ')}]${destStr}${note}`);
  }

  lines.push('');
  lines.push('=== END PROGRAM ===');
  return lines.join('\n');
}

/**
 * Extracts detailed information about the instruction program structure.
 */
export function getInstructionDebugInfo(
  instructions: readonly Instruction[],
  destinations: readonly (number | null)[]
): InstructionDebugInfo[] {
  return instructions.map((instruction, index) => ({
    index,
    note: instruction.note,
    paramCount: instruction.params.length,
    paramIndices: instruction.params.map(param =>
      instructions.findIndex(inst => inst === param)
    ),
    destination: destinations[index]
  }));
}
