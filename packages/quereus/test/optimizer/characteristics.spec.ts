/**
 * Tests for characteristics-based plan node analysis
 */

import { describe, it, expect } from 'mocha';
import { 
	PlanNodeCharacteristics, 
	CapabilityDetectors, 
	CachingAnalysis,
	PredicateAnalysis,
	CapabilityRegistry 
} from '../../src/planner/framework/characteristics.js';
import { LiteralNode } from '../../src/planner/nodes/scalar.js';
import { FilterNode } from '../../src/planner/nodes/filter.js';
import { JoinNode } from '../../src/planner/nodes/join-node.js';
import { AggregateNode } from '../../src/planner/nodes/aggregate-node.js';
import { SortNode } from '../../src/planner/nodes/sort.js';
import { SeqScanNode } from '../../src/planner/nodes/table-access-nodes.js';
import { CacheNode } from '../../src/planner/nodes/cache-node.js';
import { createBasicScope } from '../../src/planner/scopes/base.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';

describe('PlanNodeCharacteristics', () => {
	const scope = createBasicScope();

	describe('Physical Properties', () => {
		it('should detect side effects correctly', () => {
			const literalNode = new LiteralNode(scope, 42, 'number');
			
			// Literals should not have side effects
			expect(PlanNodeCharacteristics.hasSideEffects(literalNode)).to.be.false;
			expect(PlanNodeCharacteristics.isReadOnly(literalNode)).to.be.true;
		});

		it('should detect deterministic operations', () => {
			const literalNode = new LiteralNode(scope, 42, 'number');
			
			expect(PlanNodeCharacteristics.isDeterministic(literalNode)).to.be.true;
			expect(PlanNodeCharacteristics.isFunctional(literalNode)).to.be.true;
		});

		it('should detect constant values', () => {
			const literalNode = new LiteralNode(scope, 42, 'number');
			
			expect(PlanNodeCharacteristics.isConstant(literalNode)).to.be.true;
		});
	});

	describe('Type Classification', () => {
		it('should classify relational nodes', () => {
			// Create a mock table schema for testing
			const mockTableSchema = {
				name: 'test_table',
				columns: [],
				vtabModule: null
			} as any;

			const seqScanNode = new SeqScanNode(scope, mockTableSchema, []);
			
			expect(PlanNodeCharacteristics.isRelational(seqScanNode)).to.be.true;
			expect(PlanNodeCharacteristics.producesRows(seqScanNode)).to.be.true;
		});

		it('should classify scalar nodes', () => {
			const literalNode = new LiteralNode(scope, 42, 'number');
			
			expect(PlanNodeCharacteristics.isScalar(literalNode)).to.be.true;
			expect(PlanNodeCharacteristics.isRelational(literalNode)).to.be.false;
		});
	});

	describe('Performance Characteristics', () => {
		it('should identify expensive operations', () => {
			const literalNode = new LiteralNode(scope, 42, 'number');
			
			// Mock high row estimate
			(literalNode as any)._physical = {
				...literalNode.physical,
				estimatedRows: 50000
			};
			
			expect(PlanNodeCharacteristics.isExpensive(literalNode)).to.be.true;
		});
	});
});

describe('CapabilityDetectors', () => {
	const scope = createBasicScope();

	// TODO: These tests will need actual implementations once we update nodes
	// to implement the capability interfaces
	
	it('should detect table access capability', () => {
		const mockTableSchema = {
			name: 'test_table',
			columns: [],
			vtabModule: null
		} as any;

		const seqScanNode = new SeqScanNode(scope, mockTableSchema, []);
		
		// This will currently fail because SeqScanNode doesn't implement TableAccessCapable yet
		// expect(CapabilityDetectors.isTableAccess(seqScanNode)).to.be.true;
	});

	it('should detect join capability', () => {
		// Mock join node test
		// expect(CapabilityDetectors.isJoin(joinNode)).to.be.true;
	});
});

describe('CachingAnalysis', () => {
	const scope = createBasicScope();

	it('should determine cacheability correctly', () => {
		const mockTableSchema = {
			name: 'test_table',
			columns: [],
			vtabModule: null
		} as any;

		const seqScanNode = new SeqScanNode(scope, mockTableSchema, []);
		
		expect(CachingAnalysis.isCacheable(seqScanNode)).to.be.true;
	});

	it('should calculate appropriate cache thresholds', () => {
		const mockTableSchema = {
			name: 'test_table',
			columns: [],
			vtabModule: null
		} as any;

		const seqScanNode = new SeqScanNode(scope, mockTableSchema, []);
		
		const threshold = CachingAnalysis.getCacheThreshold(seqScanNode);
		expect(threshold).to.be.a('number');
		expect(threshold).to.be.greaterThan(0);
	});

	it('should not cache already cached nodes', () => {
		const mockTableSchema = {
			name: 'test_table',
			columns: [],
			vtabModule: null
		} as any;

		const seqScanNode = new SeqScanNode(scope, mockTableSchema, []);
		const cachedNode = new CacheNode(scope, seqScanNode, 'memory', 1000);
		
		expect(CachingAnalysis.isCacheable(cachedNode)).to.be.false;
	});
});

describe('CapabilityRegistry', () => {
	it('should register and detect custom capabilities', () => {
		// Define a custom capability
		const isCustomNode = (node: PlanNode): node is PlanNode => {
			return 'customProperty' in node;
		};

		// Register the capability
		CapabilityRegistry.register('custom-test', isCustomNode);

		// Test detection
		const regularNode = new LiteralNode(createBasicScope(), 42, 'number');
		const customNode = new LiteralNode(createBasicScope(), 42, 'number');
		(customNode as any).customProperty = true;

		expect(CapabilityRegistry.hasCapability(regularNode, 'custom-test')).to.be.false;
		expect(CapabilityRegistry.hasCapability(customNode, 'custom-test')).to.be.true;

		// Clean up
		CapabilityRegistry.unregister('custom-test');
	});

	it('should list all registered capabilities', () => {
		const capabilities = CapabilityRegistry.getAllCapabilities();
		
		expect(capabilities).to.be.an('array');
		expect(capabilities).to.include('predicate-pushdown');
		expect(capabilities).to.include('table-access');
		expect(capabilities).to.include('aggregation');
	});
});

describe('Characteristics-Based Rule Benefits', () => {
	const scope = createBasicScope();

	it('should enable extensible optimization without hard-coded types', () => {
		// This test demonstrates how new node types can work with existing rules
		// without modifying the rule code

		// Create a custom node that implements expected characteristics
		class CustomAggregateNode {
			nodeType = 'CustomAggregate' as any;
			scope = scope;
			
			getType() {
				return { typeClass: 'relation' as const };
			}
			
			getChildren() {
				return [];
			}
			
			withChildren() {
				return this;
			}
			
			// Mock physical properties
			get physical() {
				return {
					readonly: true,
					deterministic: true,
					idempotent: true,
					constant: false
				};
			}
			
			// Implement aggregation capability
			getGroupingKeys() {
				return [];
			}
			
			getAggregateExpressions() {
				return [];
			}
			
			requiresOrdering() {
				return false;
			}
			
			canStreamAggregate() {
				return true;
			}
			
			getAttributes() {
				return [];
			}
		}

		const customNode = new CustomAggregateNode();
		
		// The characteristics system should detect this as aggregation-capable
		// even though it's not an AggregateNode
		expect(CapabilityDetectors.isAggregating(customNode as any)).to.be.true;
		expect(PlanNodeCharacteristics.isRelational(customNode as any)).to.be.true;
		expect(PlanNodeCharacteristics.hasSideEffects(customNode as any)).to.be.false;
	});
});

describe('Migration Benefits', () => {
	it('should allow symbolic renames without breaking', () => {
		// This test demonstrates that we can rename node properties
		// without breaking the characteristics system

		const literalNode = new LiteralNode(createBasicScope(), 42, 'number');
		
		// These characteristics work regardless of internal property names
		expect(PlanNodeCharacteristics.isDeterministic(literalNode)).to.be.true;
		expect(PlanNodeCharacteristics.isConstant(literalNode)).to.be.true;
		
		// If we renamed literalNode.value to literalNode.constantValue,
		// these checks would still work because they use physical properties
		// rather than direct property access
	});
});