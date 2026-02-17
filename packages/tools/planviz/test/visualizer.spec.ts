/**
 * Unit tests for PlanVisualizer
 *
 * Tests written from the public interface without implementation bias.
 */

import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { PlanVisualizer, type PlanNode, type InstructionProgram } from '../src/visualizer.js';

/** Helper: build a leaf PlanNode. */
function leaf(nodeType: string, opts: Partial<PlanNode> = {}): PlanNode {
	return { nodeType, ...opts };
}

/** Helper: build a PlanNode with static children/relations arrays. */
function node(nodeType: string, children: PlanNode[], opts: Partial<PlanNode> = {}): PlanNode {
	return { nodeType, children, ...opts };
}

/** Helper: build a PlanNode using method-style child access. */
function methodNode(nodeType: string, childrenList: PlanNode[], relationsList: PlanNode[], opts: Partial<PlanNode> = {}): PlanNode {
	return {
		nodeType,
		getChildren: () => childrenList,
		getRelations: () => relationsList,
		...opts,
	};
}

describe('PlanVisualizer', () => {
	let viz: PlanVisualizer;

	beforeEach(() => {
		viz = new PlanVisualizer();
	});

	// ── renderTree ─────────────────────────────────────

	describe('renderTree', () => {
		it('renders a single leaf node', () => {
			const result = viz.renderTree(leaf('TableScan', { description: 'users', physical: { estimatedRows: 50 } }), 'physical');
			expect(result).to.include('Query Plan (physical)');
			expect(result).to.include('TableScan');
			expect(result).to.include('users');
			expect(result).to.include('rows: 50');
		});

		it('shows the phase label', () => {
			expect(viz.renderTree(leaf('Scan'), 'logical')).to.include('Query Plan (logical)');
			expect(viz.renderTree(leaf('Scan'), 'physical')).to.include('Query Plan (physical)');
		});

		it('renders children via static arrays', () => {
			const tree = node('Sort', [leaf('TableScan', { description: 'orders' })], { description: 'ORDER BY amount' });
			const result = viz.renderTree(tree, 'physical');
			expect(result).to.include('Sort');
			expect(result).to.include('TableScan');
			expect(result).to.include('orders');
		});

		it('renders children via methods', () => {
			const child = leaf('IndexScan', { description: 'pk_users' });
			const root = methodNode('Filter', [], [child], { description: 'age > 25' });
			const result = viz.renderTree(root, 'physical');
			expect(result).to.include('Filter');
			expect(result).to.include('IndexScan');
		});

		it('renders multi-level nesting with tree connectors', () => {
			const grandchild = leaf('TableScan', { id: 'gc', description: 'items' });
			const child = node('Join', [grandchild], { id: 'c', description: 'INNER' });
			const root = node('Project', [child], { id: 'r' });
			const result = viz.renderTree(root, 'physical');
			// Should have both └── and ├── or └── connectors for nesting
			expect(result).to.include('└──');
		});

		it('renders an InstructionProgram instead of a plan', () => {
			const prog: InstructionProgram = { type: 'program', program: 'line1 → a\nline2 → b' };
			const result = viz.renderTree(prog, 'emitted');
			expect(result).to.include('Instruction Program');
			expect(result).to.include('line1');
			expect(result).to.include('line2');
		});

		it('shows ordering from physical properties', () => {
			const p = leaf('Sort', { physical: { ordering: [{ column: 'name' }, { column: 'age', desc: true }] } });
			const result = viz.renderTree(p, 'physical');
			expect(result).to.include('order: [name, age DESC]');
		});

		it('shows logical properties', () => {
			const p = leaf('Scan', { logical: { cardinality: 42, type: 'set' } });
			const result = viz.renderTree(p, 'logical');
			expect(result).to.include('cardinality: 42');
		});

		it('does not fall back to Object.prototype.toString for description', () => {
			const p = leaf('Scan');
			const result = viz.renderTree(p, 'physical');
			expect(result).to.not.include('[object Object]');
		});
	});

	// ── renderJson ────────────────────────────────────

	describe('renderJson', () => {
		it('produces valid JSON for a plan node', () => {
			const p = leaf('TableScan', { id: 'n1', description: 'users' });
			const json = viz.renderJson(p);
			const parsed = JSON.parse(json);
			expect(parsed.nodeType).to.equal('TableScan');
		});

		it('produces valid JSON for an instruction program', () => {
			const prog: InstructionProgram = { type: 'program', program: 'inst1\ninst2' };
			const json = viz.renderJson(prog);
			const parsed = JSON.parse(json);
			expect(parsed.type).to.equal('program');
			expect(parsed.program).to.include('inst1');
		});

		it('preserves nested structure', () => {
			const tree = node('Agg', [leaf('Scan', { description: 'x' })], { description: 'GROUP BY a' });
			const json = viz.renderJson(tree);
			const parsed = JSON.parse(json);
			expect(parsed.children).to.have.length(1);
			expect(parsed.children[0].nodeType).to.equal('Scan');
		});
	});

	// ── renderMermaid ──────────────────────────────────

	describe('renderMermaid', () => {
		it('produces valid Mermaid header', () => {
			const result = viz.renderMermaid(leaf('Scan'), 'physical');
			expect(result).to.match(/^graph TD/);
			expect(result).to.include('subgraph "Query Plan (physical)"');
			expect(result).to.include('end');
		});

		it('includes node labels with metrics', () => {
			const p = leaf('TableScan', { id: 'n1', description: 'users', physical: { estimatedRows: 200 } });
			const result = viz.renderMermaid(p, 'physical');
			expect(result).to.include('TableScan');
			expect(result).to.include('users');
			expect(result).to.include('rows: 200');
		});

		it('generates deterministic node IDs when id is absent', () => {
			const p = node('Sort', [leaf('Scan')]);
			const r1 = viz.renderMermaid(p, 'physical');
			// Re-create visualizer to reset counter
			const viz2 = new PlanVisualizer();
			const r2 = viz2.renderMermaid(p, 'physical');
			expect(r1).to.equal(r2);
		});

		it('uses node.id when available', () => {
			const p = leaf('Scan', { id: 'my_scan' });
			const result = viz.renderMermaid(p, 'physical');
			expect(result).to.include('my_scan');
		});

		it('generates edges for parent-child relationships', () => {
			const child = leaf('Scan', { id: 'child1' });
			const root = node('Filter', [child], { id: 'root1' });
			const result = viz.renderMermaid(root, 'physical');
			expect(result).to.include('child1 --> root1');
		});

		it('renders instruction program as sequential Mermaid nodes', () => {
			const prog: InstructionProgram = { type: 'program', program: 'a\nb\nc' };
			const result = viz.renderMermaid(prog, 'emitted');
			expect(result).to.include('inst_0');
			expect(result).to.include('inst_1');
			expect(result).to.include('inst_2');
			expect(result).to.include('inst_0 --> inst_1');
			expect(result).to.include('inst_1 --> inst_2');
		});
	});

	// ── edge cases ─────────────────────────────────────

	describe('edge cases', () => {
		it('handles node with no children, no description, no physical', () => {
			const p = leaf('Empty');
			// Should not throw for any format
			expect(() => viz.renderTree(p, 'physical')).to.not.throw();
			expect(() => viz.renderJson(p)).to.not.throw();
			expect(() => viz.renderMermaid(p, 'physical')).to.not.throw();
		});

		it('handles empty instruction program', () => {
			const prog: InstructionProgram = { type: 'program', program: '' };
			expect(() => viz.renderTree(prog, 'emitted')).to.not.throw();
			expect(() => viz.renderMermaid(prog, 'emitted')).to.not.throw();
		});

		it('methods take precedence over static arrays for children', () => {
			const staticChild = leaf('StaticChild');
			const methodChild = leaf('MethodChild');
			const p: PlanNode = {
				nodeType: 'Root',
				children: [staticChild],
				getChildren: () => [methodChild],
			};
			const result = viz.renderTree(p, 'physical');
			expect(result).to.include('MethodChild');
			expect(result).to.not.include('StaticChild');
		});

		it('handles getLogicalProperties method', () => {
			const p: PlanNode = {
				nodeType: 'Scan',
				getLogicalProperties: () => ({ rows: 10, cost: 5 }),
			};
			const result = viz.renderTree(p, 'logical');
			expect(result).to.include('rows: 10');
		});
	});
});
