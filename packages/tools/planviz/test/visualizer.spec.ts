/**
 * Unit tests for PlanVisualizer
 */

import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { PlanVisualizer, type PlanNode, type InstructionProgram } from '../src/visualizer.js';

describe('PlanVisualizer', () => {
	let visualizer: PlanVisualizer;

	beforeEach(() => {
		visualizer = new PlanVisualizer();
	});

	describe('renderTree', () => {
		it('should render a simple plan node as tree', () => {
			const plan: PlanNode = {
				id: 'node1',
				nodeType: 'TableScan',
				description: 'users',
				physical: { estimatedRows: 1000 }
			};

			const result = visualizer.renderTree(plan, 'physical');

			expect(result).to.include('Query Plan (physical)');
			expect(result).to.include('TableScan');
			expect(result).to.include('users');
			expect(result).to.include('rows: 1000');
		});

		it('should render instruction program as tree', () => {
			const program: InstructionProgram = {
				type: 'program',
				program: 'Instruction 1 → scan users\nInstruction 2 → filter age > 25'
			};

			const result = visualizer.renderTree(program, 'emitted');

			expect(result).to.include('Instruction Program');
			expect(result).to.include('scan users');
			expect(result).to.include('filter age > 25');
		});
	});

	describe('renderJson', () => {
		it('should render plan node as JSON', () => {
			const plan: PlanNode = {
				id: 'node1',
				nodeType: 'TableScan',
				description: 'users'
			};

			const result = visualizer.renderJson(plan);

			expect(result).to.be.a('string');
			expect(() => JSON.parse(result)).to.not.throw();
		});

		it('should render instruction program as JSON', () => {
			const program: InstructionProgram = {
				type: 'program',
				program: 'Instruction 1 → scan users'
			};

			const result = visualizer.renderJson(program);
			const parsed = JSON.parse(result);

			expect(parsed.type).to.equal('program');
			expect(parsed.program).to.include('scan users');
		});
	});

	describe('renderMermaid', () => {
		it('should render plan node as Mermaid diagram', () => {
			const plan: PlanNode = {
				id: 'node1',
				nodeType: 'TableScan',
				description: 'users',
				physical: { estimatedRows: 1000 }
			};

			const result = visualizer.renderMermaid(plan, 'physical');

			expect(result).to.include('graph TD');
			expect(result).to.include('Query Plan (physical)');
			expect(result).to.include('TableScan');
			expect(result).to.include('rows: 1000');
		});

		it('should render instruction program as Mermaid diagram', () => {
			const program: InstructionProgram = {
				type: 'program',
				program: 'Instruction 1 → scan users\nInstruction 2 → filter age > 25'
			};

			const result = visualizer.renderMermaid(program, 'emitted');

			expect(result).to.include('graph TD');
			expect(result).to.include('Instruction Program');
			expect(result).to.include('inst_0');
			expect(result).to.include('inst_1');
		});
	});

	describe('complex plan trees', () => {
		it('should handle nested plan structures', () => {
			const childNode: PlanNode = {
				id: 'scan',
				nodeType: 'TableScan',
				description: 'users',
				physical: { estimatedRows: 1000 },
				getChildren: () => [],
				getRelations: () => []
			};

			const plan: PlanNode = {
				id: 'root',
				nodeType: 'StreamAggregate',
				description: 'GROUP BY name',
				physical: { estimatedRows: 100 },
				getChildren: () => [],
				getRelations: () => [childNode]
			};

			const result = visualizer.renderTree(plan, 'physical');

			expect(result).to.include('StreamAggregate');
			expect(result).to.include('TableScan');
			expect(result).to.include('└──');
		});
	});
});
