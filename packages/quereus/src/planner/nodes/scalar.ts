import type { ScalarType } from "../../common/datatype.js";
import { OutputValue, SqlDataType } from "../../common/types.js";
import { PlanNode, type ScalarPlanNode, type UnaryScalarNode, type NaryScalarNode, type ZeroAryScalarNode, type BinaryScalarNode, PhysicalProperties, type ConstantNode, type TernaryScalarNode } from "./plan-node.js";
import type * as AST from "../../parser/ast.js";
import type { Scope } from "../scopes/scope.js";
import { PlanNodeType } from "./plan-node-type.js";
import { Cached } from "../../util/cached.js";
import { formatExpression, formatScalarType } from "../../util/plan-formatter.js";
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

export class UnaryOpNode extends PlanNode implements UnaryScalarNode {
	readonly nodeType = PlanNodeType.UnaryOp;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.UnaryExpr,
		public readonly operand: ScalarPlanNode,
	) {
		super(scope);
		this.cachedType = new Cached(this.generateType);
	}

	generateType = (): ScalarType => {
		const operandType = this.operand.getType();

		let datatype: SqlDataType | undefined;
		let affinity: SqlDataType = operandType.affinity;
		let nullable = operandType.nullable;

		switch (this.expression.operator) {
			case 'NOT':
			case 'IS NULL':
			case 'IS NOT NULL':
				datatype = SqlDataType.INTEGER;
				affinity = SqlDataType.INTEGER;
				nullable = false; // Boolean results are never null
				break;
			case '-':
			case '+':
				// Numeric unary operators preserve type but may change nullability
				datatype = operandType.datatype;
				break;
			case '~':
				// Bitwise NOT - results in integer
				datatype = SqlDataType.INTEGER;
				affinity = SqlDataType.INTEGER;
				break;
		}

		return {
			typeClass: 'scalar',
			affinity,
			nullable,
			isReadOnly: operandType.isReadOnly,
			datatype,
			collationName: operandType.collationName,
		};
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	getChildren(): readonly [ScalarPlanNode] {
		return [this.operand];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			quereusError(`UnaryOpNode expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newOperand] = newChildren;

		// Type check
		if (!('expression' in newOperand)) {
			quereusError('UnaryOpNode: child must be a ScalarPlanNode', StatusCode.INTERNAL);
		}

		// Return same instance if nothing changed
		if (newOperand === this.operand) {
			return this;
		}

		// Create new instance
		return new UnaryOpNode(
			this.scope,
			this.expression,
			newOperand as ScalarPlanNode
		);
	}

	override toString(): string {
		return `${this.expression.operator} ${formatExpression(this.operand)}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			operator: this.expression.operator,
			operand: formatExpression(this.operand),
			resultType: formatScalarType(this.getType())
		};
	}


}

export class BinaryOpNode extends PlanNode implements BinaryScalarNode {
	readonly nodeType = PlanNodeType.BinaryOp;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.BinaryExpr,
		public readonly left: ScalarPlanNode,
		public readonly right: ScalarPlanNode,
	) {
		super(scope);

		this.cachedType = new Cached(this.generateType);
	}

	generateType = (): ScalarType => {
		const leftType = this.left.getType();
		const rightType = this.right.getType();

		const affinity = leftType.affinity;

		let datatype: SqlDataType | undefined;
		switch (this.expression.operator) {
			case 'OR':
			case 'AND':
			case '+':
			case '-':
			case '*':
			case '/':
			case '%':
			case '=':
			case '!=':
			case '<':
			case '<=':
			case '>':
			case '>=':
			case 'IS':
			case 'IS NOT':
			case 'IN':
				datatype = SqlDataType.INTEGER;
				break;
			case '||':
				datatype = SqlDataType.TEXT;
				break;
		};

		// TODO: Handle collation conflict
		const collationName = leftType.collationName || rightType.collationName;

		return {
			typeClass: 'scalar',
			affinity,
			nullable: leftType.nullable || rightType.nullable,
			isReadOnly: leftType.isReadOnly || rightType.isReadOnly,
			datatype,
			collationName,
		};
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	getChildren(): readonly [ScalarPlanNode, ScalarPlanNode] {
		return [this.left, this.right];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 2) {
			quereusError(`BinaryOpNode expects 2 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newLeft, newRight] = newChildren;

		// Type check
		if (!('expression' in newLeft) || !('expression' in newRight)) {
			quereusError('BinaryOpNode: children must be ScalarPlanNodes', StatusCode.INTERNAL);
		}

		// Return same instance if nothing changed
		if (newLeft === this.left && newRight === this.right) {
			return this;
		}

		// Create new instance
		return new BinaryOpNode(
			this.scope,
			this.expression,
			newLeft as ScalarPlanNode,
			newRight as ScalarPlanNode
		);
	}

	override toString(): string {
		return `${formatExpression(this.left)} ${this.expression.operator} ${formatExpression(this.right)}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			operator: this.expression.operator,
			left: formatExpression(this.left),
			right: formatExpression(this.right),
			resultType: formatScalarType(this.getType())
		};
	}


}

export class LiteralNode extends PlanNode implements ZeroAryScalarNode, ConstantNode {
	readonly nodeType = PlanNodeType.Literal;
	/**
	 * When constant folding replaces an expression with a literal, we still need to
	 * preserve the *type metadata* (affinity, collation, nullability, etc.).
	 *
	 * The optional `explicitType` allows the caller to override the
	 * automatically-derived type so that information (e.g. COLLATE NOCASE)
	 * survives the folding pass.
	 */
	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.LiteralExpr,
		private readonly explicitType?: ScalarType,
	) {
		super(scope, 0.001); // Minimal cost
	}

	getType(): ScalarType {
		// If a caller supplied an explicit type (to preserve metadata such as
		// collation) honour it verbatim.
		if (this.explicitType) {
			return this.explicitType;
		}
		const value = this.expression.value;
		if (value === null) {
			return {
				typeClass: 'scalar',
				affinity: SqlDataType.NULL,
				nullable: true,
				isReadOnly: true,
				datatype: SqlDataType.NULL,
			};
		}
		if (typeof value === 'number') {
			return {
				typeClass: 'scalar',
				affinity: SqlDataType.REAL,
				nullable: false,
				isReadOnly: true,
				datatype: SqlDataType.REAL,
			};
		}
		if (typeof value === 'bigint') {
			return {
				typeClass: 'scalar',
				affinity: SqlDataType.INTEGER,
				nullable: false,
				isReadOnly: true,
				datatype: SqlDataType.INTEGER,
			};
		}
		if (typeof value === 'string') {
			return {
				typeClass: 'scalar',
				affinity: SqlDataType.TEXT,
				nullable: false,
				isReadOnly: true,
				datatype: SqlDataType.TEXT,
			};
		}
		if (typeof value === 'boolean') {
			return {
				typeClass: 'scalar',
				affinity: SqlDataType.INTEGER,
				nullable: false,
				isReadOnly: true,
				datatype: SqlDataType.INTEGER,
			};
		}
		if (value instanceof Uint8Array) {
			return {
				typeClass: 'scalar',
				affinity: SqlDataType.BLOB,
				nullable: false,
				isReadOnly: true,
				datatype: SqlDataType.BLOB,
			};
		}
		quereusError(`Unknown literal type ${typeof value}`, StatusCode.INTERNAL);
	}

	getValue(): OutputValue {
		return this.expression.value;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			quereusError(`LiteralNode expects 0 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}
		return this; // No children, so no change
	}

	override toString(): string {
		const value = this.expression.value;
		if (value === null) return 'NULL';
		if (typeof value === 'string') return `'${value}'`;
		if (value instanceof Uint8Array) return `X'${Array.from(value, b => b.toString(16).padStart(2, '0')).join('')}'`;
		return String(value);
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			value: this.expression.value,
			resultType: formatScalarType(this.getType())
		};
	}

	override computePhysical(): Partial<PhysicalProperties> {
		return {
			constant: true,
		};
	}
}

export class CaseExprNode extends PlanNode implements NaryScalarNode {
	readonly nodeType = PlanNodeType.CaseExpr;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.CaseExpr,
		public readonly baseExpr: ScalarPlanNode | undefined,
		public readonly whenThenClauses: { when: ScalarPlanNode; then: ScalarPlanNode }[],
		public readonly elseExpr: ScalarPlanNode | undefined,
	) {
		super(scope, 0.02 * whenThenClauses.length);
		this.cachedType = new Cached(this.generateType);
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	generateType = (): ScalarType => {
		// Determine the result type based on all THEN expressions and the ELSE expression
		const resultExpressions = [
			...this.whenThenClauses.map(clause => clause.then),
			...(this.elseExpr ? [this.elseExpr] : [])
		];

		if (resultExpressions.length === 0) {
			// No THEN clauses and no ELSE - should not happen in valid SQL
			return {
				typeClass: 'scalar',
				affinity: SqlDataType.NULL,
				nullable: true,
				isReadOnly: true,
				datatype: SqlDataType.NULL,
			};
		}

		// Use the first result expression as the base type
		const firstType = resultExpressions[0].getType();
		let affinity = firstType.affinity;
		let nullable = firstType.nullable;
		let isReadOnly = firstType.isReadOnly;
		let collationName = firstType.collationName;

		// Check all other result expressions for type compatibility
		for (let i = 1; i < resultExpressions.length; i++) {
			const exprType = resultExpressions[i].getType();

			// If any result can be null, the whole CASE can be null
			if (exprType.nullable) {
				nullable = true;
			}

			// If any result is read-only, consider the whole CASE read-only
			if (exprType.isReadOnly) {
				isReadOnly = true;
			}

			// Handle collation conflicts - for now, use the first non-null collation
			if (!collationName && exprType.collationName) {
				collationName = exprType.collationName;
			}

			// TODO: Implement proper type coercion rules for SQL
			// For now, if types differ, default to TEXT affinity
			if (exprType.affinity !== affinity) {
				affinity = SqlDataType.TEXT;
			}
		}

		// If there's no ELSE clause, the result can be NULL
		if (!this.elseExpr) {
			nullable = true;
		}

		return {
			typeClass: 'scalar',
			affinity,
			nullable,
			isReadOnly,
			collationName,
			// Don't set datatype since it can vary based on runtime conditions
		};
	}

	get operands(): readonly ScalarPlanNode[] {
		const allOperands: ScalarPlanNode[] = [];

		if (this.baseExpr) {
			allOperands.push(this.baseExpr);
		}

		for (const clause of this.whenThenClauses) {
			allOperands.push(clause.when, clause.then);
		}

		if (this.elseExpr) {
			allOperands.push(this.elseExpr);
		}

		return allOperands;
	}

	getChildren(): readonly ScalarPlanNode[] {
		return this.operands;
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = this.operands.length;
		if (newChildren.length !== expectedLength) {
			quereusError(`CaseExprNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		// Type check
		for (const child of newChildren) {
			if (!('expression' in child)) {
				quereusError('CaseExprNode: all children must be ScalarPlanNodes', StatusCode.INTERNAL);
			}
		}

		// Check if anything changed
		const childrenChanged = newChildren.some((child, i) => child !== this.operands[i]);
		if (!childrenChanged) {
			return this;
		}

		// Rebuild the complex structure
		let childIndex = 0;
		let newBaseExpr: ScalarPlanNode | undefined = undefined;

		if (this.baseExpr) {
			newBaseExpr = newChildren[childIndex] as ScalarPlanNode;
			childIndex++;
		}

		const newWhenThenClauses: { when: ScalarPlanNode; then: ScalarPlanNode }[] = [];
		for (let i = 0; i < this.whenThenClauses.length; i++) {
			const when = newChildren[childIndex] as ScalarPlanNode;
			const then = newChildren[childIndex + 1] as ScalarPlanNode;
			newWhenThenClauses.push({ when, then });
			childIndex += 2;
		}

		let newElseExpr: ScalarPlanNode | undefined = undefined;
		if (this.elseExpr) {
			newElseExpr = newChildren[childIndex] as ScalarPlanNode;
		}

		// Create new instance
		return new CaseExprNode(
			this.scope,
			this.expression,
			newBaseExpr,
			newWhenThenClauses,
			newElseExpr
		);
	}

	override toString(): string {
		const baseStr = this.baseExpr ? ` ${formatExpression(this.baseExpr)}` : '';
		const whenThenStr = this.whenThenClauses
			.map(clause => ` WHEN ${formatExpression(clause.when)} THEN ${formatExpression(clause.then)}`)
			.join('');
		const elseStr = this.elseExpr ? ` ELSE ${formatExpression(this.elseExpr)}` : '';
		return `CASE${baseStr}${whenThenStr}${elseStr} END`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const props: Record<string, unknown> = {
			resultType: formatScalarType(this.getType()),
			whenThenClauses: this.whenThenClauses.map(clause => ({
				when: formatExpression(clause.when),
				then: formatExpression(clause.then)
			}))
		};

		if (this.baseExpr) {
			props.baseExpression = formatExpression(this.baseExpr);
		}

		if (this.elseExpr) {
			props.elseExpression = formatExpression(this.elseExpr);
		}

		return props;
	}
}

export class CastNode extends PlanNode implements UnaryScalarNode {
	readonly nodeType = PlanNodeType.Cast;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.CastExpr,
		public readonly operand: ScalarPlanNode,
	) {
		super(scope, 0.02); // Slightly higher cost for type conversion
		this.cachedType = new Cached(this.generateType);
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	generateType = (): ScalarType => {
		const operandType = this.operand.getType();
		const targetType = this.expression.targetType.toUpperCase();

		// Determine the SQL data type and affinity based on the target type
		let datatype: SqlDataType;
		let affinity: SqlDataType;

		switch (targetType) {
			case 'INTEGER':
			case 'INT':
			case 'TINYINT':
			case 'SMALLINT':
			case 'MEDIUMINT':
			case 'BIGINT':
			case 'UNSIGNED BIG INT':
			case 'INT2':
			case 'INT8':
				datatype = SqlDataType.INTEGER;
				affinity = SqlDataType.INTEGER;
				break;
			case 'REAL':
			case 'DOUBLE':
			case 'DOUBLE PRECISION':
			case 'FLOAT':
				datatype = SqlDataType.REAL;
				affinity = SqlDataType.REAL;
				break;
			case 'TEXT':
			case 'CHARACTER':
			case 'VARCHAR':
			case 'VARYING CHARACTER':
			case 'NCHAR':
			case 'NATIVE CHARACTER':
			case 'NVARCHAR':
			case 'CLOB':
				datatype = SqlDataType.TEXT;
				affinity = SqlDataType.TEXT;
				break;
			case 'BLOB':
				datatype = SqlDataType.BLOB;
				affinity = SqlDataType.BLOB;
				break;
			case 'NUMERIC':
			case 'DECIMAL':
			case 'BOOLEAN':
			case 'DATE':
			case 'DATETIME':
				datatype = SqlDataType.NUMERIC;
				affinity = SqlDataType.NUMERIC;
				break;
			default:
				// For unknown types, default to BLOB affinity
				datatype = SqlDataType.BLOB;
				affinity = SqlDataType.BLOB;
				break;
		}

		return {
			typeClass: 'scalar',
			affinity,
			nullable: operandType.nullable, // CAST preserves nullability
			isReadOnly: operandType.isReadOnly,
			datatype,
			collationName: affinity === SqlDataType.TEXT ? operandType.collationName : undefined,
		};
	}

	getChildren(): readonly [ScalarPlanNode] {
		return [this.operand];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			quereusError(`CastNode expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newOperand] = newChildren;

		// Type check
		if (!('expression' in newOperand)) {
			quereusError('CastNode: child must be a ScalarPlanNode', StatusCode.INTERNAL);
		}

		// Return same instance if nothing changed
		if (newOperand === this.operand) {
			return this;
		}

		// Create new instance
		return new CastNode(
			this.scope,
			this.expression,
			newOperand as ScalarPlanNode
		);
	}

	override toString(): string {
		return `CAST(${formatExpression(this.operand)} AS ${this.expression.targetType})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			operand: formatExpression(this.operand),
			targetType: this.expression.targetType,
			resultType: formatScalarType(this.getType())
		};
	}
}

export class CollateNode extends PlanNode implements UnaryScalarNode {
	readonly nodeType = PlanNodeType.Collate;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.CollateExpr,
		public readonly operand: ScalarPlanNode,
	) {
		super(scope, 0.001); // Minimal cost for COLLATE
		this.cachedType = new Cached(this.generateType);
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	generateType = (): ScalarType => {
		const operandType = this.operand.getType();

		return {
			...operandType,
			collationName: this.expression.collation.toUpperCase()
		};
	}

	getChildren(): readonly [ScalarPlanNode] {
		return [this.operand];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			quereusError(`CollateNode expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newOperand] = newChildren;

		// Type check
		if (!('expression' in newOperand)) {
			quereusError('CollateNode: child must be a ScalarPlanNode', StatusCode.INTERNAL);
		}

		// Return same instance if nothing changed
		if (newOperand === this.operand) {
			return this;
		}

		// Create new instance
		return new CollateNode(
			this.scope,
			this.expression,
			newOperand as ScalarPlanNode
		);
	}

	override toString(): string {
		return `${formatExpression(this.operand)} COLLATE ${this.expression.collation}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			operand: formatExpression(this.operand),
			collation: this.expression.collation,
			resultType: formatScalarType(this.getType())
		};
	}
}

export class BetweenNode extends PlanNode implements TernaryScalarNode {
	readonly nodeType = PlanNodeType.Between;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.BetweenExpr,
		public readonly expr: ScalarPlanNode,
		public readonly lower: ScalarPlanNode,
		public readonly upper: ScalarPlanNode,
	) {
		super(scope, 0.03); // Cost for three comparisons
	}

	getType(): ScalarType {
		// BETWEEN always returns INTEGER (0 or 1)
		return {
			typeClass: 'scalar',
			affinity: SqlDataType.INTEGER,
			nullable: false,
			isReadOnly: true,
			datatype: SqlDataType.INTEGER,
		};
	}

	getChildren(): readonly [ScalarPlanNode, ScalarPlanNode, ScalarPlanNode] {
		return [this.expr, this.lower, this.upper];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 3) {
			quereusError(`BetweenNode expects 3 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newExpr, newLower, newUpper] = newChildren;

		// Type check
		for (const child of newChildren) {
			if (!('expression' in child)) {
				quereusError('BetweenNode: all children must be ScalarPlanNodes', StatusCode.INTERNAL);
			}
		}

		// Return same instance if nothing changed
		if (newExpr === this.expr && newLower === this.lower && newUpper === this.upper) {
			return this;
		}

		// Create new instance
		return new BetweenNode(
			this.scope,
			this.expression,
			newExpr as ScalarPlanNode,
			newLower as ScalarPlanNode,
			newUpper as ScalarPlanNode
		);
	}

	override toString(): string {
		const notPrefix = this.expression.not ? 'NOT ' : '';
		return `${formatExpression(this.expr)} ${notPrefix}BETWEEN ${formatExpression(this.lower)} AND ${formatExpression(this.upper)}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			expr: formatExpression(this.expr),
			lower: formatExpression(this.lower),
			upper: formatExpression(this.upper),
			not: this.expression.not ?? false,
			resultType: formatScalarType(this.getType())
		};
	}
}
