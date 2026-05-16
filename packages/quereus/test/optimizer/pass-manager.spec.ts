import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { DEFAULT_TUNING } from '../../src/planner/optimizer.js';
import { PassManager, TraversalOrder, createPass } from '../../src/planner/framework/pass.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { OptContext } from '../../src/planner/framework/context.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type { Optimizer } from '../../src/planner/optimizer.js';
import type { StatsProvider } from '../../src/planner/stats/index.js';

type TestNode = {
	id: string;
	nodeType: PlanNodeType;
	getChildren(): readonly PlanNode[];
	withChildren(newChildren: readonly PlanNode[]): PlanNode;
	getLogicalAttributes(): Record<string, unknown>;
};

function createTestContext(db: Database, overrides?: Partial<OptContext>): OptContext {
	return {
		optimizer: {} as Optimizer,
		stats: {} as StatsProvider,
		tuning: { ...DEFAULT_TUNING, ...(overrides?.tuning ?? {}) },
		phase: 'rewrite',
		depth: 0,
		context: new Map(),
		diagnostics: {},
		db,
		visitedRules: new Map(),
		optimizedNodes: new Map(),
		...overrides,
	};
}

describe('PassManager', () => {
	it('terminates local A→B→A rewrite cycles via visited tracking', async () => {
		const db = new Database();
		try {
			let nextId = 1;
			const makeNode = (nodeType: PlanNodeType): TestNode => {
				const self: TestNode = {
					id: String(nextId++),
					nodeType,
					getChildren: () => [],
					withChildren: () => self as unknown as PlanNode,
					getLogicalAttributes: () => ({}),
				};
				return self;
			};

			const pass = createPass(
				'test-cycle',
				'Test cycle',
				'Creates a local rewrite cycle for termination testing',
				0,
				TraversalOrder.TopDown
			);

			pass.rules.push(
				{
					id: 'a-filter-to-project',
					nodeType: PlanNodeType.Filter,
					phase: 'rewrite',
					fn: () => makeNode(PlanNodeType.Project) as unknown as PlanNode,
					priority: 10
				},
				{
					id: 'b-project-to-filter',
					nodeType: PlanNodeType.Project,
					phase: 'rewrite',
					fn: () => makeNode(PlanNodeType.Filter) as unknown as PlanNode,
					priority: 20
				},
			);

			const pm = new PassManager([]);
			pm.registerPass(pass);

			const context = createTestContext(db, {
				tuning: { ...DEFAULT_TUNING, maxOptimizationDepth: 100 }
			});

			const root = makeNode(PlanNodeType.Filter);
			const optimized = pm.execute(root as unknown as PlanNode, context);

			expect(optimized.nodeType).to.equal(PlanNodeType.Filter);

			const anyVisitedIncludesBoth = Array.from(context.visitedRules.values()).some(set =>
				set.has('a-filter-to-project') && set.has('b-project-to-filter')
			);
			expect(anyVisitedIncludesBoth).to.equal(true);
		} finally {
			await db.close();
		}
	});

	it('enforces maxOptimizationDepth during pass traversal', async () => {
		const db = new Database();
		try {
			let nextId = 1;
			const makeChain = (length: number): TestNode => {
				let current: TestNode | null = null;
				for (let i = 0; i < length; i++) {
					const child = current;
					const self: TestNode = {
						id: String(nextId++),
						nodeType: PlanNodeType.Filter,
						getChildren: () => (child ? [child as unknown as PlanNode] : []),
						withChildren: () => self as unknown as PlanNode,
						getLogicalAttributes: () => ({}),
					};
					current = self;
				}
				return current!;
			};

			const pass = createPass(
				'test-depth',
				'Test depth limiting',
				'Ensures traversal depth is bounded by tuning',
				0,
				TraversalOrder.TopDown
			);

			const pm = new PassManager([]);
			pm.registerPass(pass);

			// Use headroom: 0 so the budget is bounded by maxOptimizationDepth
			// vs. the input depth alone — otherwise the new input-scaled budget
			// would absorb the test chain.
			const context = createTestContext(db, {
				tuning: { ...DEFAULT_TUNING, maxOptimizationDepth: 5, optimizationDepthHeadroom: 0 }
			});

			const deepPlan = makeChain(20);

			expect(() => pm.execute(deepPlan as unknown as PlanNode, context)).to.throw(/Maximum optimization depth exceeded/);
		} finally {
			await db.close();
		}
	});

	it('depth budget scales with input plan depth (deep chains plan cleanly under default tuning)', async () => {
		const db = new Database();
		try {
			let nextId = 1;
			const makeChain = (length: number): TestNode => {
				let current: TestNode | null = null;
				for (let i = 0; i < length; i++) {
					const child = current;
					const self: TestNode = {
						id: String(nextId++),
						nodeType: PlanNodeType.Filter,
						getChildren: () => (child ? [child as unknown as PlanNode] : []),
						withChildren: () => self as unknown as PlanNode,
						getLogicalAttributes: () => ({}),
					};
					current = self;
				}
				return current!;
			};

			const pass = createPass(
				'test-deep-input',
				'Test deep input',
				'Deep input must not trip the depth guard under default tuning',
				0,
				TraversalOrder.TopDown
			);
			const pm = new PassManager([]);
			pm.registerPass(pass);

			// 200-deep chain — far exceeds default maxOptimizationDepth (50)
			// but should plan cleanly because the input-scaled budget kicks in.
			const deepPlan = makeChain(200);
			const context = createTestContext(db, { tuning: DEFAULT_TUNING });

			expect(() => pm.execute(deepPlan as unknown as PlanNode, context)).to.not.throw();
		} finally {
			await db.close();
		}
	});

	it('maxRulesFired trips when total rule firings exceed the budget', async () => {
		const db = new Database();
		try {
			let nextId = 1;
			const makeFilterNode = (children: PlanNode[]): TestNode => {
				const self: TestNode = {
					id: String(nextId++),
					nodeType: PlanNodeType.Filter,
					getChildren: () => children,
					withChildren: (newChildren) => makeFilterNode([...newChildren]) as unknown as PlanNode,
					getLogicalAttributes: () => ({}),
				};
				return self;
			};

			// Build a 200-deep chain of distinct Filter nodes
			let current: TestNode = makeFilterNode([]);
			for (let i = 1; i < 200; i++) {
				current = makeFilterNode([current as unknown as PlanNode]);
			}

			const pass = createPass(
				'test-rules-fired',
				'Test rules-fired budget',
				'A rule firing on every node in a long chain must trip the rules-fired budget',
				0,
				TraversalOrder.TopDown
			);
			// Rule rewrites every Filter to a fresh Filter (different identity)
			// once per original node. Across 200 chain levels that's 200 firings,
			// well over the 50-budget set below.
			pass.rules.push({
				id: 'always-rewrite',
				nodeType: PlanNodeType.Filter,
				phase: 'rewrite',
				fn: (node) => makeFilterNode([...node.getChildren()]) as unknown as PlanNode,
				priority: 10,
			});

			const pm = new PassManager([]);
			pm.registerPass(pass);
			const context = createTestContext(db, {
				tuning: { ...DEFAULT_TUNING, maxRulesFired: 50 }
			});

			expect(() => pm.execute(current as unknown as PlanNode, context))
				.to.throw(/maxRulesFired/);
		} finally {
			await db.close();
		}
	});
});

