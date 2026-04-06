/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import { PlanNode, type PhysicalProperties, type Attribute } from '../../src/planner/nodes/plan-node.js';
import type { BaseType, RelationType, ScalarType } from '../../src/common/datatype.js';
import type { Scope } from '../../src/planner/scopes/scope.js';
import { QuereusError } from '../../src/common/errors.js';
import { validatePhysicalTree, quickValidate } from '../../src/planner/validation/plan-validator.js';
import {
	checkDeterministic,
	validateDeterministicExpression,
	validateDeterministicConstraint,
	validateDeterministicDefault,
	validateDeterministicGenerated,
} from '../../src/planner/validation/determinism-validator.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const mockScope = { resolveSymbol: () => undefined } as unknown as Scope;

let mockIdCounter = 200000;

/** Minimal mock PlanNode for unit testing validation code. */
class MockPlanNode extends PlanNode {
	override readonly nodeType: PlanNodeType;
	private readonly _children: PlanNode[];
	private readonly _type: BaseType;
	private readonly _physicalOverride?: Partial<PhysicalProperties>;
	private readonly _attributes?: readonly Attribute[];

	constructor(opts: {
		nodeType?: PlanNodeType;
		children?: PlanNode[];
		type?: BaseType;
		physical?: Partial<PhysicalProperties>;
		attributes?: readonly Attribute[];
	} = {}) {
		super(mockScope, 0.01);
		(this as any).id = `mock-${mockIdCounter++}`;
		this.nodeType = opts.nodeType ?? PlanNodeType.Filter;
		this._children = opts.children ?? [];
		this._type = opts.type ?? { typeClass: 'relation', columns: [] } as any;
		this._physicalOverride = opts.physical;
		this._attributes = opts.attributes;
	}

	getType(): BaseType { return this._type; }
	getChildren(): readonly PlanNode[] { return this._children; }

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		return new MockPlanNode({
			nodeType: this.nodeType,
			children: [...newChildren],
			type: this._type,
			physical: this._physicalOverride,
			attributes: this._attributes,
		});
	}

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return this._physicalOverride ?? {};
	}

	override getAttributes(): readonly Attribute[] {
		return this._attributes ?? [];
	}
}

const INT_TYPE: ScalarType = {
	typeClass: 'scalar',
	logicalType: { name: 'INTEGER', affinity: 'integer', isNumeric: true } as any,
	nullable: false,
	isReadOnly: false,
};

const RELATION_TYPE: RelationType = {
	typeClass: 'relation',
	columns: [],
	keys: [],
	rowConstraints: [],
	isReadOnly: false,
	isSet: false,
} as any;

/** Create a relational mock node with attributes */
function relNode(opts: {
	nodeType?: PlanNodeType;
	children?: PlanNode[];
	physical?: Partial<PhysicalProperties>;
	attributes?: readonly Attribute[];
} = {}): MockPlanNode {
	return new MockPlanNode({
		...opts,
		type: RELATION_TYPE,
	});
}

/** Create a scalar mock node */
function scalarNode(opts: {
	nodeType?: PlanNodeType;
	children?: PlanNode[];
	physical?: Partial<PhysicalProperties>;
} = {}): MockPlanNode {
	return new MockPlanNode({
		...opts,
		type: INT_TYPE,
	});
}

/** Create a void mock node (DDL-like) */
function voidNode(opts: {
	nodeType?: PlanNodeType;
	children?: PlanNode[];
	physical?: Partial<PhysicalProperties>;
} = {}): MockPlanNode {
	return new MockPlanNode({
		...opts,
		type: { typeClass: 'void' },
	});
}

function makeAttr(id: number, name = `col_${id}`, sourceRelation = 'test.t'): Attribute {
	return { id, name, type: INT_TYPE, sourceRelation, relationName: 't' };
}

/** Mock scalar node for determinism-validator (needs .physical and .toString()) */
function mockScalar(deterministic: boolean, label = 'expr'): any {
	return {
		physical: { deterministic, readonly: true },
		toString: () => label,
	};
}

// ---------------------------------------------------------------------------
// plan-validator.ts tests
// ---------------------------------------------------------------------------

describe('plan-validator', () => {

	describe('attribute ID uniqueness', () => {
		it('accepts unique attribute IDs across nodes', () => {
			const child = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(1), makeAttr(2)],
				physical: { deterministic: true, readonly: true },
			});
			const parent = relNode({
				nodeType: PlanNodeType.Filter,
				children: [child],
				attributes: [makeAttr(3), makeAttr(4)],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(parent)).not.to.throw();
		});

		it('rejects duplicate attribute IDs across nodes', () => {
			const child = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(10), makeAttr(11)],
				physical: { deterministic: true, readonly: true },
			});
			// Parent reuses attribute ID 10
			const parent = relNode({
				nodeType: PlanNodeType.Filter,
				children: [child],
				attributes: [makeAttr(10)],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(parent)).to.throw(QuereusError, /Duplicate attribute ID 10/);
		});

		it('rejects duplicate attribute IDs within the same node', () => {
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(5), makeAttr(5)],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(node)).to.throw(QuereusError, /Duplicate attribute ID 5/);
		});
	});

	describe('column reference validation', () => {
		it('rejects ColumnReference pointing to nonexistent attribute ID', () => {
			// Parent defines attributes 20, 21
			const colRef = new MockPlanNode({
				nodeType: PlanNodeType.ColumnReference,
				type: INT_TYPE,
				physical: { deterministic: true, readonly: true },
			});
			// Patch attributeId onto the mock (ColumnReferenceNode has this property)
			(colRef as any).attributeId = 999;

			const parent = relNode({
				nodeType: PlanNodeType.Filter,
				children: [colRef],
				attributes: [makeAttr(20), makeAttr(21)],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(parent)).to.throw(QuereusError, /unknown attribute ID 999/);
		});

		it('accepts ColumnReference pointing to a valid attribute ID', () => {
			const colRef = new MockPlanNode({
				nodeType: PlanNodeType.ColumnReference,
				type: INT_TYPE,
				physical: { deterministic: true, readonly: true },
			});
			(colRef as any).attributeId = 30;

			const parent = relNode({
				nodeType: PlanNodeType.Filter,
				children: [colRef],
				attributes: [makeAttr(30), makeAttr(31)],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(parent)).not.to.throw();
		});
	});

	describe('physical property presence', () => {
		it('rejects node with deterministic not a boolean', () => {
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(40)],
				physical: { deterministic: 'yes' as any, readonly: true },
			});
			expect(() => validatePhysicalTree(node)).to.throw(QuereusError, /invalid deterministic flag/);
		});

		it('rejects node with readonly not a boolean', () => {
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(41)],
				physical: { deterministic: true, readonly: undefined as any },
			});
			expect(() => validatePhysicalTree(node)).to.throw(QuereusError, /invalid readonly flag/);
		});

		it('rejects node with negative estimatedRows', () => {
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(42)],
				physical: { deterministic: true, readonly: true, estimatedRows: -5 },
			});
			expect(() => validatePhysicalTree(node)).to.throw(QuereusError, /negative estimated rows/);
		});

		it('accepts node with valid estimatedRows', () => {
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(43)],
				physical: { deterministic: true, readonly: true, estimatedRows: 100 },
			});
			expect(() => validatePhysicalTree(node)).not.to.throw();
		});

		it('rejects node with invalid idempotent flag', () => {
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(44)],
				physical: { deterministic: true, readonly: true, idempotent: 1 as any },
			});
			expect(() => validatePhysicalTree(node)).to.throw(QuereusError, /invalid idempotent flag/);
		});

		it('skips physical property validation when requirePhysical is false', () => {
			// A node whose physical override would fail validation
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(45)],
				physical: { deterministic: 'nope' as any, readonly: true },
			});
			// Should not throw when requirePhysical is disabled
			expect(() => validatePhysicalTree(node, { requirePhysical: false })).not.to.throw();
		});
	});

	describe('logical-only node rejection', () => {
		it('rejects Aggregate (logical-only) in physical tree', () => {
			const node = relNode({
				nodeType: PlanNodeType.Aggregate,
				attributes: [makeAttr(50)],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(node)).to.throw(QuereusError, /Logical-only node type Aggregate/);
		});

		it('rejects Retrieve (logical-only) in physical tree', () => {
			const node = relNode({
				nodeType: PlanNodeType.Retrieve,
				attributes: [makeAttr(51)],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(node)).to.throw(QuereusError, /Logical-only node type Retrieve/);
		});

		it('accepts physical node types', () => {
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(52)],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(node)).not.to.throw();
		});
	});

	describe('side effect consistency', () => {
		it('rejects node with side effects marked as constant', () => {
			const node = relNode({
				nodeType: PlanNodeType.Insert,
				attributes: [makeAttr(60)],
				physical: { deterministic: true, readonly: false, constant: true },
			});
			expect(() => validatePhysicalTree(node)).to.throw(QuereusError, /side effects but is marked as constant/);
		});

		it('accepts node with side effects not marked as constant', () => {
			const node = relNode({
				nodeType: PlanNodeType.Insert,
				attributes: [makeAttr(61)],
				physical: { deterministic: true, readonly: false, constant: false },
			});
			expect(() => validatePhysicalTree(node)).not.to.throw();
		});
	});

	describe('DDL node special-casing', () => {
		it('CreateTable passes without attributes', () => {
			const node = relNode({
				nodeType: PlanNodeType.CreateTable,
				attributes: [],
				physical: { deterministic: true, readonly: true },
			});
			// Should not throw — DDL nodes don't need attributes
			expect(() => validatePhysicalTree(node)).not.to.throw();
		});

		it('DropTable passes without attributes', () => {
			const node = relNode({
				nodeType: PlanNodeType.DropTable,
				attributes: [],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(node)).not.to.throw();
		});

		it('AlterTable passes without attributes', () => {
			const node = relNode({
				nodeType: PlanNodeType.AlterTable,
				attributes: [],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(node)).not.to.throw();
		});

		it('Transaction passes without attributes', () => {
			const node = relNode({
				nodeType: PlanNodeType.Transaction,
				attributes: [],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(node)).not.to.throw();
		});

		it('Pragma passes without attributes', () => {
			const node = relNode({
				nodeType: PlanNodeType.Pragma,
				attributes: [],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(node)).not.to.throw();
		});
	});

	describe('ordering validation', () => {
		it('rejects ordering with out-of-range column index', () => {
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(70), makeAttr(71)],
				physical: {
					deterministic: true,
					readonly: true,
					ordering: [{ column: 5, desc: false }], // Only 2 attributes → valid indices 0-1
				},
			});
			expect(() => validatePhysicalTree(node)).to.throw(QuereusError, /Ordering column index 5 out of range/);
		});

		it('rejects ordering with negative column index', () => {
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(72)],
				physical: {
					deterministic: true,
					readonly: true,
					ordering: [{ column: -1, desc: false }],
				},
			});
			expect(() => validatePhysicalTree(node)).to.throw(QuereusError, /Ordering column index -1 out of range/);
		});

		it('accepts valid ordering', () => {
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(73), makeAttr(74), makeAttr(75)],
				physical: {
					deterministic: true,
					readonly: true,
					ordering: [{ column: 0, desc: false }, { column: 2, desc: true }],
				},
			});
			expect(() => validatePhysicalTree(node)).not.to.throw();
		});

		it('skips ordering validation when validateOrdering is false', () => {
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(76)],
				physical: {
					deterministic: true,
					readonly: true,
					ordering: [{ column: 99, desc: false }],
				},
			});
			expect(() => validatePhysicalTree(node, { validateOrdering: false })).not.to.throw();
		});
	});

	describe('attribute validation', () => {
		it('rejects attribute with non-number ID', () => {
			const badAttr = { ...makeAttr(80), id: 'abc' as any };
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [badAttr],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(node)).to.throw(QuereusError, /Invalid attribute ID/);
		});

		it('rejects attribute with empty name', () => {
			const badAttr = makeAttr(81);
			(badAttr as any).name = '';
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [badAttr],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(node)).to.throw(QuereusError, /invalid name/);
		});

		it('rejects attribute with missing sourceRelation', () => {
			const badAttr = makeAttr(82);
			(badAttr as any).sourceRelation = '';
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [badAttr],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(node)).to.throw(QuereusError, /invalid source relation/);
		});

		it('skips attribute validation when validateAttributes is false', () => {
			const badAttr = makeAttr(83);
			(badAttr as any).name = '';
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [badAttr],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(node, { validateAttributes: false })).not.to.throw();
		});
	});

	describe('shared child / DAG references', () => {
		it('does not crash when a child is referenced from two parents', () => {
			const shared = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(90)],
				physical: { deterministic: true, readonly: true },
			});
			// Build a parent that references `shared` twice — attribute 90 will be
			// registered on the first visit and found as a duplicate on the second.
			// The key thing we test: no infinite loop or stack overflow.
			const parent = relNode({
				nodeType: PlanNodeType.Filter,
				children: [shared, shared],
				attributes: [makeAttr(91)],
				physical: { deterministic: true, readonly: true },
			});
			// We expect a duplicate attribute error, but definitely not a hang
			expect(() => validatePhysicalTree(parent)).to.throw(QuereusError, /Duplicate attribute ID 90/);
		});
	});

	describe('valid plans pass', () => {
		it('accepts a well-formed multi-level plan', () => {
			const scan = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(100), makeAttr(101)],
				physical: { deterministic: true, readonly: true, estimatedRows: 50 },
			});
			const filter = relNode({
				nodeType: PlanNodeType.Filter,
				children: [scan],
				attributes: [makeAttr(102)],
				physical: { deterministic: true, readonly: true },
			});
			const project = relNode({
				nodeType: PlanNodeType.Project,
				children: [filter],
				attributes: [makeAttr(103)],
				physical: { deterministic: true, readonly: true },
			});
			expect(() => validatePhysicalTree(project)).not.to.throw();
		});

		it('quickValidate returns true for valid plan', () => {
			const node = relNode({
				nodeType: PlanNodeType.SeqScan,
				attributes: [makeAttr(110)],
				physical: { deterministic: true, readonly: true },
			});
			expect(quickValidate(node)).to.equal(true);
		});

		it('quickValidate returns false for invalid plan', () => {
			const node = relNode({
				nodeType: PlanNodeType.Aggregate,
				attributes: [makeAttr(111)],
				physical: { deterministic: true, readonly: true },
			});
			expect(quickValidate(node)).to.equal(false);
		});
	});
});

// ---------------------------------------------------------------------------
// determinism-validator.ts tests
// ---------------------------------------------------------------------------

describe('determinism-validator', () => {

	describe('checkDeterministic', () => {
		it('returns valid for deterministic expression', () => {
			const result = checkDeterministic(mockScalar(true, 'abs(x)'));
			expect(result.valid).to.equal(true);
			expect(result.expression).to.be.undefined;
		});

		it('returns invalid for non-deterministic expression', () => {
			const result = checkDeterministic(mockScalar(false, 'random()'));
			expect(result.valid).to.equal(false);
			expect(result.expression).to.equal('random()');
		});
	});

	describe('validateDeterministicExpression', () => {
		it('does not throw for deterministic expression', () => {
			expect(() => validateDeterministicExpression(mockScalar(true), 'test context')).not.to.throw();
		});

		it('throws for non-deterministic expression', () => {
			expect(() => validateDeterministicExpression(mockScalar(false, 'random()'), 'DEFAULT'))
				.to.throw(QuereusError, /Non-deterministic expression not allowed in DEFAULT/);
		});

		it('error message includes the expression representation', () => {
			expect(() => validateDeterministicExpression(mockScalar(false, 'now()'), 'CHECK'))
				.to.throw(QuereusError, /Expression: now\(\)/);
		});

		it('error message suggests mutation context workaround', () => {
			expect(() => validateDeterministicExpression(mockScalar(false, 'x'), 'ctx'))
				.to.throw(QuereusError, /mutation context/);
		});
	});

	describe('validateDeterministicConstraint', () => {
		it('passes for deterministic constraint', () => {
			expect(() => validateDeterministicConstraint(mockScalar(true), 'ck_positive', 'orders'))
				.not.to.throw();
		});

		it('throws with constraint and table name in message', () => {
			expect(() => validateDeterministicConstraint(mockScalar(false, 'random() > 0'), 'ck_rand', 'items'))
				.to.throw(QuereusError, /CHECK constraint 'ck_rand' on table 'items'/);
		});
	});

	describe('validateDeterministicDefault', () => {
		it('passes for deterministic default', () => {
			expect(() => validateDeterministicDefault(mockScalar(true), 'status', 'orders'))
				.not.to.throw();
		});

		it('throws with column and table name in message', () => {
			expect(() => validateDeterministicDefault(mockScalar(false, "datetime('now')"), 'created_at', 'users'))
				.to.throw(QuereusError, /DEFAULT for column 'created_at' in table 'users'/);
		});
	});

	describe('validateDeterministicGenerated', () => {
		it('passes for deterministic generated column', () => {
			expect(() => validateDeterministicGenerated(mockScalar(true), 'full_name', 'users'))
				.not.to.throw();
		});

		it('throws with column and table name in message', () => {
			expect(() => validateDeterministicGenerated(mockScalar(false, 'random()'), 'token', 'sessions'))
				.to.throw(QuereusError, /GENERATED ALWAYS AS for column 'token' in table 'sessions'/);
		});
	});

	describe('NULL literal determinism', () => {
		it('NULL literal is deterministic', () => {
			const result = checkDeterministic(mockScalar(true, 'NULL'));
			expect(result.valid).to.equal(true);
		});
	});

	describe('function determinism', () => {
		it('abs(x) is deterministic', () => {
			const result = checkDeterministic(mockScalar(true, 'abs(x)'));
			expect(result.valid).to.equal(true);
		});

		it('random() is non-deterministic', () => {
			const result = checkDeterministic(mockScalar(false, 'random()'));
			expect(result.valid).to.equal(false);
			expect(result.expression).to.equal('random()');
		});
	});
});
