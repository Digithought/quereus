/**
 * Plan visualization and formatting utilities
 */

import chalk from 'chalk';
import { serializePlanTree } from '@quereus/quereus';

export interface PhysicalProperties {
	estimatedRows?: number;
	ordering?: readonly { column: string; desc?: boolean }[];
	[key: string]: unknown;
}

export interface PlanNode {
	id?: string;
	nodeType: string;
	description?: string;
	logical?: Record<string, unknown>;
	physical?: PhysicalProperties;
	children?: readonly PlanNode[];
	relations?: readonly PlanNode[];

	// Methods that might be available on actual plan nodes
	getChildren?(): readonly PlanNode[];
	getRelations?(): readonly PlanNode[];
	getLogicalProperties?(): Record<string, unknown>;
}

export interface InstructionProgram {
	type: 'program';
	program: string;
}

function isInstructionProgram(plan: PlanNode | InstructionProgram): plan is InstructionProgram {
	return 'type' in plan && (plan as InstructionProgram).type === 'program';
}

/** Collect all children and relations from a node, preferring methods over static arrays. */
function gatherChildren(node: PlanNode): readonly PlanNode[] {
	const result: PlanNode[] = [];
	if (node.getChildren) {
		result.push(...node.getChildren());
	} else if (node.children) {
		result.push(...node.children);
	}
	if (node.getRelations) {
		result.push(...node.getRelations());
	} else if (node.relations) {
		result.push(...node.relations);
	}
	return result;
}

/** Get the node description, using the explicit property only (not toString). */
function getNodeDescription(node: PlanNode): string | undefined {
	return node.description;
}

export class PlanVisualizer {
	private nextNodeId = 0;

	/** Render plan as a tree structure. */
	renderTree(plan: PlanNode | InstructionProgram, phase: string): string {
		if (isInstructionProgram(plan)) {
			return this.renderInstructionTree(plan);
		}

		const lines: string[] = [];
		lines.push(chalk.bold.blue(`Query Plan (${phase}):`));
		lines.push('');

		this.renderNodeTree(plan, '', true, lines);

		return lines.join('\n');
	}

	/** Render plan as JSON. */
	renderJson(plan: PlanNode | InstructionProgram): string {
		if (isInstructionProgram(plan)) {
			return JSON.stringify(plan, null, 2);
		}

		// Use engine serialization for real PlanNode objects (with visit method); fall back to JSON.stringify
		if (typeof (plan as any).visit === 'function') {
			return serializePlanTree(plan as any);
		}
		return JSON.stringify(plan, null, 2);
	}

	/** Render plan as Mermaid diagram. */
	renderMermaid(plan: PlanNode | InstructionProgram, phase: string): string {
		if (isInstructionProgram(plan)) {
			return this.renderInstructionMermaid(plan);
		}

		this.nextNodeId = 0;
		const lines: string[] = [];
		lines.push('graph TD');
		lines.push(`  subgraph "Query Plan (${phase})"`);

		const nodeMap = new Map<string, string>();
		const edges: string[] = [];

		this.buildMermaidNodes(plan, nodeMap, edges);

		for (const [nodeId, nodeLabel] of nodeMap) {
			lines.push(`    ${nodeId}["${nodeLabel}"]`);
		}

		for (const edge of edges) {
			lines.push(`    ${edge}`);
		}

		lines.push('  end');

		return lines.join('\n');
	}

	private renderNodeTree(node: PlanNode, prefix: string, isLast: boolean, lines: string[]): void {
		const connector = isLast ? '└── ' : '├── ';
		const nodeInfo = this.formatNodeInfo(node);

		lines.push(prefix + connector + nodeInfo);

		const allChildren = gatherChildren(node);
		const childPrefix = prefix + (isLast ? '    ' : '│   ');

		allChildren.forEach((child, index) => {
			this.renderNodeTree(child, childPrefix, index === allChildren.length - 1, lines);
		});
	}

	private renderInstructionTree(program: InstructionProgram): string {
		const lines: string[] = [];
		lines.push(chalk.bold.blue('Instruction Program:'));
		lines.push('');

		const programLines = program.program.split('\n').filter(line => line.trim());

		programLines.forEach((line, index) => {
			const isLast = index === programLines.length - 1;
			const connector = isLast ? '└── ' : '├── ';
			const coloredLine = line.includes('→') ? chalk.cyan(line) : chalk.gray(line);
			lines.push(connector + coloredLine);
		});

		return lines.join('\n');
	}

	private formatNodeInfo(node: PlanNode): string {
		let info = chalk.cyan.bold(node.nodeType);

		const description = getNodeDescription(node);
		if (description) {
			info += ' ' + chalk.gray(description);
		}

		const props = this.collectNodeProps(node);
		if (props.length > 0) {
			info += ' ' + chalk.yellow(`(${props.join(', ')})`);
		}

		return info;
	}

	private collectNodeProps(node: PlanNode): string[] {
		const props: string[] = [];

		if (node.physical?.estimatedRows !== undefined) {
			props.push(`rows: ${node.physical.estimatedRows}`);
		}

		if (node.physical?.ordering && Array.isArray(node.physical.ordering)) {
			const orderStr = node.physical.ordering
				.map((o) => `${o.column}${o.desc ? ' DESC' : ''}`)
				.join(', ');
			props.push(`order: [${orderStr}]`);
		}

		let logical = node.logical;
		if (!logical && node.getLogicalProperties) {
			logical = node.getLogicalProperties();
		}

		if (logical) {
			for (const key of Object.keys(logical).slice(0, 2)) {
				const value = logical[key];
				if (typeof value === 'string' || typeof value === 'number') {
					props.push(`${key}: ${value}`);
				}
			}
		}

		return props;
	}

	private buildMermaidNodes(
		node: PlanNode,
		nodeMap: Map<string, string>,
		edges: string[]
	): string {
		const nodeId = node.id || `node_${this.nextNodeId++}`;
		const nodeLabel = this.getMermaidNodeLabel(node);

		nodeMap.set(nodeId, nodeLabel);

		for (const child of gatherChildren(node)) {
			const childId = this.buildMermaidNodes(child, nodeMap, edges);
			edges.push(`${childId} --> ${nodeId}`);
		}

		return nodeId;
	}

	private getMermaidNodeLabel(node: PlanNode): string {
		let label = node.nodeType;

		const description = getNodeDescription(node);
		if (description) {
			label += `<br/>${description}`;
		}

		if (node.physical?.estimatedRows !== undefined) {
			label += `<br/>rows: ${node.physical.estimatedRows}`;
		}

		return label;
	}

	private renderInstructionMermaid(program: InstructionProgram): string {
		const lines: string[] = [];
		lines.push('graph TD');
		lines.push('  subgraph "Instruction Program"');

		const programLines = program.program.split('\n').filter(line => line.trim());

		programLines.forEach((line, index) => {
			const nodeId = `inst_${index}`;
			const cleanLine = line.trim().replace(/"/g, '\\"');
			const label = cleanLine || `Instruction ${index}`;

			lines.push(`    ${nodeId}["${label}"]`);

			if (index < programLines.length - 1) {
				lines.push(`    ${nodeId} --> inst_${index + 1}`);
			}
		});

		lines.push('  end');

		return lines.join('\n');
	}
}
