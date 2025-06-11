/**
 * Plan visualization and formatting utilities
 */

import chalk from 'chalk';
import { serializePlanTree } from '@quereus/quereus';

export interface PlanNode {
	id?: string;
	nodeType: string;
	description?: string;
	logical?: Record<string, unknown>;
	physical?: any; // More flexible type to handle different physical property structures
	children?: readonly PlanNode[];
	relations?: readonly PlanNode[];

	// Methods that might be available on actual plan nodes
	getChildren?(): readonly PlanNode[];
	getRelations?(): readonly PlanNode[];
	toString?(): string;
	getLogicalProperties?(): Record<string, unknown>;
}

export interface InstructionProgram {
	type: 'program';
	program: string; // String representation of the instruction program
}

export class PlanVisualizer {
	/**
	 * Render plan as a tree structure
	 */
	renderTree(plan: PlanNode | InstructionProgram, phase: string): string {
		if ('type' in plan && plan.type === 'program') {
			return this.renderInstructionTree(plan);
		}

		const lines: string[] = [];
		lines.push(chalk.bold.blue(`Query Plan (${phase}):`));
		lines.push('');

		this.renderNodeTree(plan as PlanNode, '', true, lines);

		return lines.join('\n');
	}

	/**
	 * Render plan as JSON
	 */
	renderJson(plan: PlanNode | InstructionProgram): string {
		if ('type' in plan && plan.type === 'program') {
			return JSON.stringify(plan, null, 2);
		}

		// For plan nodes, use the same serialization as golden plan tests
		return serializePlanTree(plan as any);
	}

	/**
	 * Render plan as Mermaid diagram
	 */
	renderMermaid(plan: PlanNode | InstructionProgram, phase: string): string {
		if ('type' in plan && plan.type === 'program') {
			return this.renderInstructionMermaid(plan);
		}

		const lines: string[] = [];
		lines.push('graph TD');
		lines.push(`  subgraph "Query Plan (${phase})"`);

		const nodeMap = new Map<string, string>();
		const edges: string[] = [];

		this.buildMermaidNodes(plan as PlanNode, nodeMap, edges);

		// Add nodes
		for (const [nodeId, nodeLabel] of nodeMap) {
			lines.push(`    ${nodeId}["${nodeLabel}"]`);
		}

		// Add edges
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

		// Get all children (both direct children and relations)
		const allChildren: PlanNode[] = [];

		// Try methods first, fallback to properties
		if (node.getChildren) {
			allChildren.push(...node.getChildren());
		} else if (node.children) {
			allChildren.push(...node.children);
		}

		if (node.getRelations) {
			allChildren.push(...node.getRelations());
		} else if (node.relations) {
			allChildren.push(...node.relations);
		}

		const childPrefix = prefix + (isLast ? '    ' : '│   ');

		allChildren.forEach((child, index) => {
			const isLastChild = index === allChildren.length - 1;
			this.renderNodeTree(child, childPrefix, isLastChild, lines);
		});
	}

	private renderInstructionTree(program: InstructionProgram): string {
		const lines: string[] = [];
		lines.push(chalk.bold.blue('Instruction Program:'));
		lines.push('');

		// Split the program string into lines and format them
		const programLines = program.program.split('\n').filter(line => line.trim());

		programLines.forEach((line, index) => {
			const isLast = index === programLines.length - 1;
			const connector = isLast ? '└── ' : '├── ';

			// Add basic coloring to the instruction line
			const coloredLine = line.includes('→') ?
				chalk.cyan(line) :
				chalk.gray(line);

			lines.push(connector + coloredLine);
		});

		return lines.join('\n');
	}

	private formatNodeInfo(node: PlanNode): string {
		let info = chalk.cyan.bold(node.nodeType);

		// Try to get description from toString() method or description property
		let description = node.description;
		if (!description && node.toString) {
			description = node.toString();
		}

		if (description) {
			info += ' ' + chalk.gray(description);
		}

		// Add key properties
		const props: string[] = [];

		if (node.physical?.estimatedRows !== undefined) {
			props.push(`rows: ${node.physical.estimatedRows}`);
		}

		if (node.physical?.ordering && Array.isArray(node.physical.ordering)) {
			const orderStr = node.physical.ordering
				.map((o: any) => `${o.column}${o.desc ? ' DESC' : ''}`)
				.join(', ');
			props.push(`order: [${orderStr}]`);
		}

		// Try to get logical properties
		let logical = node.logical;
		if (!logical && node.getLogicalProperties) {
			logical = node.getLogicalProperties();
		}

		if (logical) {
			const logicalKeys = Object.keys(logical).slice(0, 2); // Show first 2 logical properties
			for (const key of logicalKeys) {
				const value = logical[key];
				if (typeof value === 'string' || typeof value === 'number') {
					props.push(`${key}: ${value}`);
				}
			}
		}

		if (props.length > 0) {
			info += ' ' + chalk.yellow(`(${props.join(', ')})`);
		}

		return info;
	}

		private buildMermaidNodes(
		node: PlanNode,
		nodeMap: Map<string, string>,
		edges: string[]
	): string {
		const nodeId = node.id || `node_${Math.random().toString(36).substring(7)}`;
		const nodeLabel = this.getMermaidNodeLabel(node);

		nodeMap.set(nodeId, nodeLabel);

		// Process children and relations
		const allChildren: PlanNode[] = [];

		// Try methods first, fallback to properties
		if (node.getChildren) {
			allChildren.push(...node.getChildren());
		} else if (node.children) {
			allChildren.push(...node.children);
		}

		if (node.getRelations) {
			allChildren.push(...node.getRelations());
		} else if (node.relations) {
			allChildren.push(...node.relations);
		}

		for (const child of allChildren) {
			const childId = this.buildMermaidNodes(child, nodeMap, edges);
			edges.push(`${childId} --> ${nodeId}`);
		}

		return nodeId;
	}

	private getMermaidNodeLabel(node: PlanNode): string {
		let label = node.nodeType;

		// Try to get description from toString() method or description property
		let description = node.description;
		if (!description && node.toString) {
			description = node.toString();
		}

		if (description) {
			label += `<br/>${description}`;
		}

		// Add key metrics
		if (node.physical?.estimatedRows !== undefined) {
			label += `<br/>rows: ${node.physical.estimatedRows}`;
		}

		return label;
	}

	private renderInstructionMermaid(program: InstructionProgram): string {
		const lines: string[] = [];
		lines.push('graph TD');
		lines.push('  subgraph "Instruction Program"');

		// Split the program string into lines and create nodes
		const programLines = program.program.split('\n').filter(line => line.trim());

		programLines.forEach((line, index) => {
			const nodeId = `inst_${index}`;
			// Clean up the line for display and escape quotes
			const cleanLine = line.trim().replace(/"/g, '\\"');
			const label = cleanLine || `Instruction ${index}`;

			lines.push(`    ${nodeId}["${label}"]`);

			// Connect to next instruction
			if (index < programLines.length - 1) {
				lines.push(`    ${nodeId} --> inst_${index + 1}`);
			}
		});

		lines.push('  end');

		return lines.join('\n');
	}
}
