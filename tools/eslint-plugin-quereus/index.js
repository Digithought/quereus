/**
 * ESLint plugin for Quereus development
 * Provides rules to enforce coding conventions in the Quereus codebase
 */

const physicalNodeTypes = new Set([
	'SeqScanNode',
	'IndexScanNode',
	'IndexSeekNode',
	'StreamAggregateNode',
	'HashAggregateNode',
	'NestedLoopJoinNode',
	'HashJoinNode',
	'MergeJoinNode'
	// Add more physical node types as they're implemented
]);

module.exports = {
	rules: {
		'no-physical-in-builder': {
			meta: {
				type: 'problem',
				docs: {
					description: 'Disallow creation of physical nodes in builder code',
					category: 'Best Practices',
					recommended: true
				},
				schema: []
			},
			create(context) {
				return {
					'NewExpression[callee.name=/.*Node$/]'(node) {
						const fileName = context.getFilename();
						const constructorName = node.callee.name;

						// Only check files in the planner/building directory
						if (!fileName.includes('/planner/building/')) {
							return;
						}

						// Check if this is a physical node type
						if (physicalNodeTypes.has(constructorName)) {
							context.report({
								node,
								message: `Physical node '${constructorName}' must be created in optimizer rules, not builder code. Builders should create logical nodes only.`
							});
						}
					}
				};
			}
		}
	}
};
